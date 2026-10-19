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
    /** MCP explicit edits are not human confirmations. */
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
  const tags = (threadId: ThreadId) =>
    sql`SELECT thread_id AS threadId, label_id AS labelId, confidence, confirmed_by_user AS confirmedByUser, source FROM thread_project_labels WHERE thread_id = ${threadId} ORDER BY label_id`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeTag({ ...row, confirmedByUser: row.confirmedByUser === 1 }),
        ),
      ),
      Effect.map((labels) => ({ labels })),
      Effect.mapError(failure("threadLabels")),
    );
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
          yield* sql`INSERT OR IGNORE INTO label_repositories(label_id, repository_id) VALUES (${input.labelId}, ${input.repositoryId})`;
        } else
          yield* sql`DELETE FROM label_repositories WHERE label_id = ${input.labelId} AND repository_id = ${input.repositoryId}`;
        yield* sql`UPDATE project_labels SET updated_at = ${yield* now} WHERE label_id = ${input.labelId}`;
        return yield* get(input.labelId);
      }),
    );
  return ProjectLabelService.of({
    list,
    read: get,
    subscribe: () =>
      subscribe(list, (event) => "type" in event && event.type === "project.deleted"),
    getThreadLabels,
    subscribeThreadLabels: (threadId) =>
      Stream.unwrap(
        requireThread(threadId).pipe(
          Effect.mapError(failure("subscribeThreadLabels")),
          Effect.as(
            subscribe(
              () => tags(threadId),
              (stored) =>
                "event" in stored &&
                stored.event.type === "thread.deleted" &&
                stored.event.threadId === threadId,
            ),
          ),
        ),
      ),
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
        sql`DELETE FROM project_labels WHERE label_id = ${id} RETURNING label_id`.pipe(
          Effect.map((rows) => ({ deleted: rows.length > 0 })),
        ),
      ),
    linkRepository: (input) => repository(input, true),
    unlinkRepository: (input) => repository(input, false),
    setThreadLabels: (input, confirmedByUser = true) =>
      mutate(
        "setThreadLabels",
        { ...input, confirmedByUser },
        Effect.gen(function* () {
          yield* requireThread(input.threadId);
          const ids = [...new Set(input.labelIds)];
          for (const id of ids) yield* get(id);
          yield* sql`DELETE FROM thread_project_labels WHERE thread_id = ${input.threadId}`;
          for (const id of ids) {
            yield* sql`DELETE FROM thread_project_label_rejections WHERE thread_id = ${input.threadId} AND label_id = ${id}`;
            yield* sql`INSERT INTO thread_project_labels(thread_id, label_id, confidence, confirmed_by_user, source) VALUES (${input.threadId}, ${id}, NULL, ${confirmedByUser ? 1 : 0}, 'user')`;
          }
          return yield* tags(input.threadId);
        }),
      ),
    reviewSuggestion: (input) =>
      mutate(
        "reviewSuggestion",
        input,
        Effect.gen(function* () {
          yield* requireThread(input.threadId);
          const pending =
            yield* sql`SELECT 1 FROM thread_project_labels WHERE thread_id = ${input.threadId} AND label_id = ${input.labelId} AND source = 'suggested' AND confirmed_by_user = 0`;
          if (!pending.length)
            return yield* new ProjectLabelError({
              operation: "reviewSuggestion",
              reason: "not_suggested",
            });
          if (input.accept)
            yield* sql`UPDATE thread_project_labels SET confirmed_by_user = 1 WHERE thread_id = ${input.threadId} AND label_id = ${input.labelId}`;
          else {
            yield* sql`DELETE FROM thread_project_labels WHERE thread_id = ${input.threadId} AND label_id = ${input.labelId}`;
            yield* sql`INSERT OR IGNORE INTO thread_project_label_rejections(thread_id, label_id) VALUES (${input.threadId}, ${input.labelId})`;
          }
          return yield* tags(input.threadId);
        }),
      ),
    // TextGeneration exposes purpose-specific title/Git operations, not general classification.
    // Bound input to the first four messages and use explainable repo/keyword evidence.
    suggestLabels: (threadId) =>
      mutate(
        "suggestLabels",
        { threadId },
        Effect.gen(function* () {
          const thread = yield* requireThread(threadId);
          const messages = yield* sql<{
            text: string;
          }>`SELECT substr(json_extract(payload_json, '$.text'), 1, 2000) AS text FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND role IN ('user', 'assistant') ORDER BY created_at, message_id LIMIT 4`;
          const words = new Set(
            messages.flatMap((m) => (m.text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
          );
          const { labels } = yield* list();
          const rejected = yield* sql<{
            label_id: string;
          }>`SELECT label_id FROM thread_project_label_rejections WHERE thread_id = ${threadId}`;
          const blocked = new Set(rejected.map((r) => r.label_id));
          for (const label of labels) {
            if (blocked.has(label.id)) continue;
            const nameWords = label.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
            const descriptionWords =
              label.description?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
            const repoMatch = label.repositoryIds.some((id) => id === thread.project_id);
            const nameMatch = nameWords.some((w) => w.length >= 3 && words.has(w));
            const descriptionMatches = new Set(
              descriptionWords.filter((w) => w.length >= 4 && words.has(w)),
            ).size;
            if (!repoMatch && !nameMatch && descriptionMatches < 2) continue;
            const confidence = Math.min(
              0.95,
              (repoMatch ? 0.7 : 0) +
                (nameMatch ? 0.2 : 0) +
                Math.min(0.15, descriptionMatches * 0.05),
            );
            // Existing explicit/confirmed assignments always win; suggestions never confirm themselves.
            yield* sql`INSERT INTO thread_project_labels(thread_id, label_id, confidence, confirmed_by_user, source) VALUES (${threadId}, ${label.id}, ${confidence}, 0, 'suggested') ON CONFLICT(thread_id, label_id) DO UPDATE SET confidence = excluded.confidence WHERE source = 'suggested' AND confirmed_by_user = 0`;
          }
          return yield* tags(threadId);
        }),
      ),
  });
});
export const layer = Layer.effect(ProjectLabelService, make);
