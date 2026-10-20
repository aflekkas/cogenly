import {
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ThreadProjectLabel,
  type ProjectLabelCreateInput,
  type ProjectLabelUpdateInput,
  type ProjectLabelRepository,
  type SetThreadProjectLabelsInput,
  type ReviewThreadProjectLabelInput,
  type MoveThreadProjectFolderInput,
  type ThreadProjectFolderResult,
  type ThreadId,
  type ApplicationStoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";

type Labels = { readonly labels: ReadonlyArray<ProjectLabelWithRepositories> };
type Tags = { readonly labels: ReadonlyArray<ThreadProjectLabel> };
export class ProjectLabelService extends Context.Service<
  ProjectLabelService,
  {
    readonly read: (
      id: ProjectLabelId,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    readonly moveThread: (
      input: MoveThreadProjectFolderInput,
    ) => Effect.Effect<ThreadProjectFolderResult, ProjectLabelError>;
    readonly list: () => Effect.Effect<Labels, ProjectLabelError>;
    readonly subscribe: () => Stream.Stream<Labels, ProjectLabelError>;
    readonly create: (
      input: ProjectLabelCreateInput,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly update: (
      input: ProjectLabelUpdateInput,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly delete: (id: ProjectLabelId) => Effect.Effect<{ deleted: boolean }, ProjectLabelError>;
    readonly linkRepository: (
      input: ProjectLabelRepository,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly unlinkRepository: (
      input: ProjectLabelRepository,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly getThreadLabels: (threadId: ThreadId) => Effect.Effect<Tags, ProjectLabelError>;
    readonly subscribeThreadLabels: (threadId: ThreadId) => Stream.Stream<Tags, ProjectLabelError>;
    /** Effective folder memberships across every live thread. */
    readonly subscribeConfirmedThreadLabels: () => Stream.Stream<Tags, ProjectLabelError>;
    /** Legacy singleton wrapper; use moveThread for new clients. */
    readonly setThreadLabels: (
      input: SetThreadProjectLabelsInput,
      confirmedByUser?: boolean,
    ) => Effect.Effect<Tags, ProjectLabelError>;
    readonly reviewSuggestion: (
      input: ReviewThreadProjectLabelInput,
    ) => Effect.Effect<Tags, ProjectLabelError>;
    readonly suggestLabels: (threadId: ThreadId) => Effect.Effect<Tags, ProjectLabelError>;
  }
>()("t3/projectLabels/ProjectLabelService") {}

const isProjectLabelError = Schema.is(ProjectLabelError);
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectId)),
);
const decodeLabel = Schema.decodeUnknownEffect(ProjectLabelWithRepositories);
const decodeTag = Schema.decodeUnknownEffect(ThreadProjectLabel);
const encodeAudit = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const events = yield* Events.OrchestrationEventStore;
  const changes = yield* PubSub.sliding<void>(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const failure = (operation: string) => (cause: unknown) =>
    isProjectLabelError(cause)
      ? cause
      : new ProjectLabelError({ operation, reason: "storage", cause });
  const missing = (operation: string) => new ProjectLabelError({ operation, reason: "not_found" });
  const readLabels = (id?: ProjectLabelId) =>
    sql`SELECT label_id AS id, name, color, description, created_at AS createdAt, updated_at AS updatedAt,
    (SELECT json_group_array(repository_id) FROM (SELECT repository_id FROM label_repositories r WHERE r.label_id = l.label_id ORDER BY repository_id)) AS repositories
    , (SELECT count(*) FROM effective_thread_project_folders f WHERE f.folder_id = l.label_id) AS threadCount
    FROM project_labels l ${id === undefined ? sql`` : sql`WHERE label_id = ${id}`} ORDER BY name COLLATE NOCASE, label_id`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const repositoryIds = yield* decodeRepositories(row.repositories);
            return yield* decodeLabel({
              ...row,
              color: row.color ?? undefined,
              description: row.description ?? undefined,
              repositoryIds,
            });
          }),
        ),
      ),
      Effect.map((labels) => ({ labels })),
      Effect.mapError(failure("list")),
    );
  const list = () => readLabels();
  const get = (id: ProjectLabelId) =>
    readLabels(id).pipe(
      Effect.flatMap(({ labels }) => {
        const label = labels.find((l) => l.id === id);
        return label ? Effect.succeed({ label }) : Effect.fail(missing("get"));
      }),
    );
  const requireThread = (threadId: ThreadId) =>
    sql<{
      project_id: string;
    }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(missing("thread")),
      ),
    );
  const memberships = (threadId?: ThreadId) =>
    sql`SELECT thread_id AS threadId, folder_id AS labelId
      FROM effective_thread_project_folders WHERE folder_id IS NOT NULL
      ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`} ORDER BY thread_id`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTag({
            ...row,
            confidence: null,
            confirmedByUser: true,
            source: "user",
          }),
        ),
      ),
      Effect.map((labels) => ({ labels })),
      Effect.mapError(failure("threadFolders")),
    );
  const tags = (threadId: ThreadId) => memberships(threadId);
  const confirmedTags = () => memberships();
  const getThreadLabels = (threadId: ThreadId) =>
    requireThread(threadId).pipe(
      Effect.andThen(tags(threadId)),
      Effect.mapError(failure("threadLabels")),
    );
  // Audit, state, and result commit together; invalidations are emitted only after commit.
  const mutate = <A, E>(operation: string, input: unknown, effect: Effect.Effect<A, E>) =>
    Effect.uninterruptible(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const result = yield* effect;
            const payload = yield* encodeAudit({ input, result });
            yield* sql`INSERT INTO project_label_audit(operation, occurred_at, payload_json) VALUES (${operation}, ${yield* now}, ${payload})`;
            return result;
          }),
        )
        .pipe(
          Effect.tap(() => PubSub.publish(changes, undefined)),
          Effect.mapError(failure(operation)),
        ),
    );
  const subscribe = <A>(
    read: () => Effect.Effect<A, ProjectLabelError>,
    affected: (event: ApplicationStoredEvent) => boolean,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const afterSequence = yield* events.latestApplicationSequence.pipe(
          Effect.mapError(failure("subscribe")),
        );
        const deletions = events
          .streamProjectedApplicationEvents({
            afterSequence,
            project: (event) => ({ sequence: event.sequence, affected: affected(event) }),
          })
          .pipe(
            Stream.filter((event) => event.affected),
            Stream.map(() => undefined),
            Stream.mapError(failure("subscribe")),
          );
        return Stream.concat(
          Stream.fromEffect(read()),
          Stream.merge(Stream.fromSubscription(subscription), deletions).pipe(
            Stream.mapEffect(read),
          ),
        );
      }),
    );
  const repository = (input: ProjectLabelRepository, link: boolean) =>
    mutate(
      link ? "linkRepository" : "unlinkRepository",
      input,
      Effect.gen(function* () {
        yield* get(input.labelId);
        if (link) {
          const rows =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${input.repositoryId} AND deleted_at IS NULL`;
          if (!rows.length) return yield* missing("repository");
          yield* sql`INSERT INTO label_repositories(label_id, repository_id) VALUES (${input.labelId}, ${input.repositoryId}) ON CONFLICT(repository_id) DO UPDATE SET label_id = excluded.label_id`;
        } else
          yield* sql`DELETE FROM label_repositories WHERE label_id = ${input.labelId} AND repository_id = ${input.repositoryId}`;
        yield* sql`UPDATE project_labels SET updated_at = ${yield* now} WHERE label_id = ${input.labelId}`;
        return yield* get(input.labelId);
      }),
    );
  const moveThread = (input: MoveThreadProjectFolderInput) =>
    mutate(
      "moveThread",
      input,
      Effect.gen(function* () {
        yield* requireThread(input.threadId);
        if (input.folderId !== null) yield* get(input.folderId);
        yield* sql`DELETE FROM thread_project_labels WHERE thread_id = ${input.threadId}`;
        if (input.folderId !== null)
          yield* sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${input.threadId}, ${input.folderId})`;
        const { labels } = yield* tags(input.threadId);
        return { threadId: input.threadId, projectFolderId: labels[0]?.labelId ?? null };
      }),
    );
  const membershipLifecycle = (stored: ApplicationStoredEvent) =>
    ("type" in stored && stored.type === "project.deleted") ||
    ("event" in stored &&
      ["thread.created", "thread.deleted", "thread.metadata-updated"].includes(stored.event.type));
  return ProjectLabelService.of({
    moveThread,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    list,
    read: get,
    subscribe: () => subscribe(list, membershipLifecycle),
    getThreadLabels,
    subscribeThreadLabels: (threadId) =>
      Stream.unwrap(
        requireThread(threadId).pipe(
          Effect.mapError(failure("subscribeThreadLabels")),
          Effect.as(subscribe(() => tags(threadId), membershipLifecycle)),
        ),
      ),
    subscribeConfirmedThreadLabels: () => subscribe(confirmedTags, membershipLifecycle),
    create: (input) =>
      mutate(
        "create",
        input,
        Effect.gen(function* () {
          const id = ProjectLabelId.make(`label:${yield* crypto.randomUUIDv4()}`);
          const at = yield* now;
          yield* sql`INSERT INTO project_labels(label_id, name, color, description, created_at, updated_at) VALUES (${id}, ${input.name}, ${input.color ?? null}, ${input.description ?? null}, ${at}, ${at})`;
          return yield* get(id);
        }),
      ),
    update: (input) =>
      mutate(
        "update",
        input,
        Effect.gen(function* () {
          const { label } = yield* get(input.id);
          yield* sql`UPDATE project_labels SET name = ${input.name ?? label.name}, color = ${input.color === undefined ? (label.color ?? null) : input.color}, description = ${input.description === undefined ? (label.description ?? null) : input.description}, updated_at = ${yield* now} WHERE label_id = ${input.id}`;
          return yield* get(input.id);
        }),
      ),
    delete: (id) =>
      mutate(
        "delete",
        { id },
        Effect.gen(function* () {
          yield* sql`UPDATE commitments SET payload_json = json_set(payload_json, '$.labelIds', json(
            (SELECT json_group_array(l.value) FROM json_each(commitments.payload_json, '$.labelIds') l WHERE l.value <> ${id})
          )) WHERE id IN (SELECT commitment_id FROM commitment_labels WHERE label_id = ${id})`;
          yield* sql`DELETE FROM commitment_labels WHERE label_id = ${id}`;
          const at = yield* now;
          yield* sql`UPDATE facts SET updated_at=${at},payload_json = json_set(payload_json, '$.updatedAt',${at},'$.labelIds', json(
            (SELECT json_group_array(l.value) FROM json_each(facts.payload_json, '$.labelIds') l WHERE l.value <> ${id})
          )) WHERE id IN (SELECT fact_id FROM fact_labels WHERE label_id = ${id})`;
          yield* sql`INSERT INTO fact_history(fact_id,payload_json) SELECT f.id,json_object('id',${yield* crypto.randomUUIDv4()} || ':' || f.id,'factId',f.id,'who','user','at',${at},'fact',json(f.payload_json)) FROM facts f WHERE f.id IN (SELECT fact_id FROM fact_labels WHERE label_id=${id})`;
          const rows =
            yield* sql`DELETE FROM project_labels WHERE label_id = ${id} RETURNING label_id`;
          return { deleted: rows.length > 0 };
        }),
      ),
    linkRepository: (input) => repository(input, true),
    unlinkRepository: (input) => repository(input, false),
    setThreadLabels: (input) => {
      const ids = [...new Set(input.labelIds)];
      if (ids.length > 1)
        return Effect.fail(
          new ProjectLabelError({ operation: "setThreadLabels", reason: "invalid_membership" }),
        );
      return moveThread({ threadId: input.threadId, folderId: ids[0] ?? null }).pipe(
        Effect.map(({ projectFolderId }) => ({
          labels:
            projectFolderId === null
              ? []
              : [
                  {
                    threadId: input.threadId,
                    labelId: projectFolderId,
                    confidence: null,
                    confirmedByUser: true,
                    source: "user" as const,
                  },
                ],
        })),
      );
    },
    // Kept as inert compatibility endpoints for older clients. Folder filing is
    // always explicit or derived from the repository, never keyword-suggested.
    reviewSuggestion: () =>
      Effect.fail(
        new ProjectLabelError({ operation: "reviewSuggestion", reason: "not_suggested" }),
      ),
    suggestLabels: getThreadLabels,
  });
});
export const layer = Layer.effect(ProjectLabelService, make);
