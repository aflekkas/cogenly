import {
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
  ThreadProjectLabel,
  type ProjectLabelCreateInput,
  type ProjectLabelUpdateInput,
  type ProjectLabelRepository,
  type ProjectLabelSourceLinkInput,
  type SetThreadProjectLabelsInput,
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
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectLabelFolders from "./ProjectLabelFolders.ts";

type Labels = { readonly labels: ReadonlyArray<ProjectLabelWithRepositories> };
type Tags = { readonly labels: ReadonlyArray<ThreadProjectLabel> };
export class ProjectLabelService extends Context.Service<
  ProjectLabelService,
  {
    readonly read: (
      id: ProjectLabelId,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    /**
     * Reads a project that may take new threads or repositories, failing
     * `archived` otherwise. moveThread and linkRepository enforce it
     * themselves; callers that create something before filing it (a launch,
     * fork, clone or new repository) check first so a refusal leaves nothing
     * behind.
     */
    readonly readActive: (
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
    /**
     * Archives the project: it leaves pickers but keeps its threads, chat,
     * repositories and filing, and refuses new threads and repositories until
     * unarchived. Archiving an archived project keeps its date.
     */
    readonly archive: (
      id: ProjectLabelId,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    /** Brings an archived project back; a no-op for an active one. */
    readonly unarchive: (
      id: ProjectLabelId,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly linkRepository: (
      input: ProjectLabelRepository,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly unlinkRepository: (
      input: ProjectLabelRepository,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly linkSource: (
      input: ProjectLabelSourceLinkInput,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly unlinkSource: (
      input: ProjectLabelSourceLinkInput,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    /** Records the project's own chat; ProjectHome owns creating it. */
    readonly setProjectChat: (input: {
      readonly id: ProjectLabelId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly getThreadLabels: (threadId: ThreadId) => Effect.Effect<Tags, ProjectLabelError>;
    readonly subscribeThreadLabels: (threadId: ThreadId) => Stream.Stream<Tags, ProjectLabelError>;
    /** Effective folder memberships across every live thread. */
    readonly subscribeConfirmedThreadLabels: () => Stream.Stream<Tags, ProjectLabelError>;
    /** Legacy singleton wrapper; use moveThread for new clients. */
    readonly setThreadLabels: (
      input: SetThreadProjectLabelsInput,
      confirmedByUser?: boolean,
    ) => Effect.Effect<Tags, ProjectLabelError>;
  }
>()("t3/projectLabels/ProjectLabelService") {}

const isProjectLabelError = Schema.is(ProjectLabelError);
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectId)),
);
const decodeSourceLinkRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ kind: Schema.String, owner: Schema.String, repo: Schema.String })),
  ),
);
const decodeSourceLink = Schema.decodeUnknownOption(ProjectSourceLink);
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
    sql`SELECT label_id AS id, name, color, description, instructions, project_chat_thread_id AS projectChatThreadId, archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt,
    (SELECT json_group_array(repository_id) FROM (SELECT repository_id FROM label_repositories r WHERE r.label_id = l.label_id ORDER BY repository_id)) AS repositories
    , (SELECT json_group_array(json(source)) FROM (SELECT json_object('kind', kind, 'owner', owner, 'repo', repo) AS source FROM label_source_links s WHERE s.label_id = l.label_id ORDER BY kind, owner, repo)) AS sources
    , (SELECT count(*) FROM effective_thread_project_folders f
      JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
      WHERE f.folder_id = l.label_id AND t.archived_at IS NULL
        AND t.thread_id IS NOT l.project_chat_thread_id
        AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
        AND (json_extract(t.payload_json, '$.agent.role') = 'work' OR (
          json_extract(t.payload_json, '$.agent') IS NULL
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.conversation_thread_id = t.thread_id)
        ))) AS threadCount
    FROM project_labels l ${id === undefined ? sql`` : sql`WHERE label_id = ${id}`} ORDER BY name COLLATE NOCASE, label_id`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const repositoryIds = yield* decodeRepositories(row.repositories);
            const sourceLinkRows = yield* decodeSourceLinkRows(row.sources);
            const sourceLinks = sourceLinkRows.flatMap((source) =>
              source.kind === "github-owner"
                ? Option.toArray(decodeSourceLink({ kind: source.kind, owner: source.owner }))
                : Option.toArray(
                    decodeSourceLink({
                      kind: "github-repo",
                      owner: source.owner,
                      repo: source.repo,
                    }),
                  ),
            );
            return yield* decodeLabel({
              ...row,
              color: row.color ?? undefined,
              description: row.description ?? undefined,
              archivedAt: row.archivedAt ?? undefined,
              instructions: row.instructions ?? "",
              repositoryIds,
              sourceLinks,
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
  // The one archive guard: everything that files into a project passes it.
  const readActive = (id: ProjectLabelId) =>
    get(id).pipe(
      Effect.flatMap((found) =>
        found.label.archivedAt === undefined
          ? Effect.succeed(found)
          : Effect.fail(
              new ProjectLabelError({
                operation: "readActive",
                reason: "archived",
                projectName: found.label.name,
              }),
            ),
      ),
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
  // Optional so layers built without process access (unit tests over a memory
  // database) still link repositories; production always provides it, and only
  // then does linking auto-add the repository's own source link below.
  const identities = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );
  // Optional for the same reason: without it labels have no folders, and the
  // folder reconcile heals anything created meanwhile once it is provided.
  const folders = yield* Effect.serviceOption(ProjectLabelFolders.ProjectLabelFolders);
  // Folder work runs after the database commit, so a disk failure never
  // rolls back the label; startup reconcile heals the folder later.
  const syncFolder = (
    label: { id: ProjectLabelId; name: string },
    renamed: boolean,
  ): Effect.Effect<void> =>
    Option.isNone(folders)
      ? Effect.void
      : (renamed ? folders.value.renameForLabel(label) : folders.value.ensureForLabel(label)).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Project folder could not be synced; reconcile will retry it.", {
              labelId: label.id,
              cause,
            }),
          ),
        );
  // A linked repository files its own GitHub link with the project, so owner
  // search and the picker know it without a manual step. Best-effort: no
  // remote, a non-GitHub remote, or an unparseable one simply adds nothing.
  const autoAddRepositorySourceLink = Effect.fn("ProjectLabelService.autoAddRepositorySourceLink")(
    function* (labelId: ProjectLabelId, repositoryId: ProjectId) {
      if (Option.isNone(identities)) return;
      const rows = yield* sql<{
        workspace_root: string;
      }>`SELECT workspace_root FROM projection_projects WHERE project_id = ${repositoryId} AND deleted_at IS NULL`;
      const workspaceRoot = rows[0]?.workspace_root;
      if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return;
      const identity = yield* identities.value.resolve(workspaceRoot);
      if (identity?.provider !== "github" || !identity.owner || !identity.name) return;
      const link = Option.getOrUndefined(
        decodeSourceLink({ kind: "github-repo", owner: identity.owner, repo: identity.name }),
      );
      if (!link || link.kind !== "github-repo") return;
      yield* sql`INSERT INTO label_source_links(label_id, kind, owner, repo, created_at) VALUES (${labelId}, ${link.kind}, ${link.owner}, ${link.repo}, ${yield* now}) ON CONFLICT(label_id, kind, owner, repo) DO NOTHING`;
    },
  );
  const repository = (input: ProjectLabelRepository, link: boolean) =>
    mutate(
      link ? "linkRepository" : "unlinkRepository",
      input,
      Effect.gen(function* () {
        const { label } = yield* get(input.labelId);
        if (link && !label.repositoryIds.includes(input.repositoryId))
          yield* readActive(input.labelId);
        if (link) {
          const rows =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${input.repositoryId} AND deleted_at IS NULL`;
          if (!rows.length) return yield* missing("repository");
          yield* sql`INSERT INTO label_repositories(label_id, repository_id) VALUES (${input.labelId}, ${input.repositoryId}) ON CONFLICT(repository_id) DO UPDATE SET label_id = excluded.label_id`;
          yield* autoAddRepositorySourceLink(input.labelId, input.repositoryId);
        } else
          yield* sql`DELETE FROM label_repositories WHERE label_id = ${input.labelId} AND repository_id = ${input.repositoryId}`;
        yield* sql`UPDATE project_labels SET updated_at = ${yield* now} WHERE label_id = ${input.labelId}`;
        return yield* get(input.labelId);
      }),
    );
  const sourceLink = (input: ProjectLabelSourceLinkInput, link: boolean) =>
    mutate(
      link ? "linkSource" : "unlinkSource",
      input,
      Effect.gen(function* () {
        yield* get(input.id);
        const repo = input.link.kind === "github-owner" ? "" : input.link.repo;
        if (link) {
          yield* sql`INSERT INTO label_source_links(label_id, kind, owner, repo, created_at) VALUES (${input.id}, ${input.link.kind}, ${input.link.owner}, ${repo}, ${yield* now}) ON CONFLICT(label_id, kind, owner, repo) DO NOTHING`;
        } else {
          yield* sql`DELETE FROM label_source_links WHERE label_id = ${input.id} AND kind = ${input.link.kind} AND owner = ${input.link.owner} AND repo = ${repo}`;
        }
        yield* sql`UPDATE project_labels SET updated_at = ${yield* now} WHERE label_id = ${input.id}`;
        return yield* get(input.id);
      }),
    );
  const moveThread = (input: MoveThreadProjectFolderInput) =>
    mutate(
      "moveThread",
      input,
      Effect.gen(function* () {
        yield* requireThread(input.threadId);
        // A project's own conversation lives on its page: it may be filed in
        // that project (as ProjectHome does) but never moved out or elsewhere.
        const home = yield* sql<{
          readonly labelId: string;
          readonly name: string;
        }>`SELECT label_id AS labelId, name FROM project_labels WHERE project_chat_thread_id = ${input.threadId} LIMIT 1`;
        const owner = home[0];
        if (owner !== undefined && owner.labelId !== input.folderId)
          return yield* new ProjectLabelError({
            operation: "moveThread",
            reason: "project_chat",
            projectName: owner.name,
          });
        if (input.folderId !== null) {
          // Only filing into an archived project is refused: unfiling, moving
          // out, and re-filing where the thread already is stay allowed.
          const current = (yield* tags(input.threadId)).labels[0]?.labelId;
          yield* (current === input.folderId ? get : readActive)(input.folderId);
          // A chat with turns moves by forking, not by re-parenting: its
          // scratch working directory no longer matches the project dir, so
          // the history moves to a new chat through a context transfer
          // instead (forkThreadToProject). Turnless chats still assign
          // directly, unfiling stays allowed, and Work threads keep following
          // their repo. A persistent agent's conversation is its one ongoing
          // thread, so it re-files in place: the agents row identifies it
          // even when a migrated shell lacks the agent annotation.
          const turned = yield* sql`SELECT 1 AS one FROM orchestration_v2_projection_threads t
              WHERE t.thread_id = ${input.threadId} AND t.deleted_at IS NULL
              AND COALESCE(json_extract(t.payload_json, '$.surface'), 'chat') = 'chat'
              AND COALESCE(json_extract(t.payload_json, '$.agent.role'), '') NOT IN ('work', 'conversation')
              AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.conversation_thread_id = t.thread_id)
              AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id) LIMIT 1`;
          if (turned.length > 0)
            return yield* new ProjectLabelError({
              operation: "moveThread",
              reason: "fork_required",
            });
        }
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
      [
        "thread.created",
        "thread.deleted",
        "thread.metadata-updated",
        "thread.archived",
        "thread.unarchived",
      ].includes(stored.event.type));
  return ProjectLabelService.of({
    moveThread,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    list,
    read: get,
    readActive,
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
          yield* sql`INSERT INTO project_labels(label_id, name, color, description, instructions, created_at, updated_at) VALUES (${id}, ${input.name}, ${input.color ?? null}, ${input.description ?? null}, ${input.instructions ?? ""}, ${at}, ${at})`;
          return yield* get(id);
        }),
      ).pipe(Effect.tap(({ label }) => syncFolder(label, false))),
    update: (input) =>
      Effect.gen(function* () {
        const previous = (yield* get(input.id)).label.name;
        const result = yield* mutate(
          "update",
          input,
          Effect.gen(function* () {
            const { label } = yield* get(input.id);
            yield* sql`UPDATE project_labels SET name = ${input.name ?? label.name}, color = ${input.color === undefined ? (label.color ?? null) : input.color}, description = ${input.description === undefined ? (label.description ?? null) : input.description}, instructions = ${input.instructions ?? label.instructions}, updated_at = ${yield* now} WHERE label_id = ${input.id}`;
            return yield* get(input.id);
          }),
        );
        yield* syncFolder(result.label, input.name !== undefined && input.name !== previous);
        return result;
      }),
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
    archive: (id) =>
      mutate(
        "archive",
        { id },
        Effect.gen(function* () {
          yield* get(id);
          const at = yield* now;
          yield* sql`UPDATE project_labels SET archived_at = ${at}, updated_at = ${at} WHERE label_id = ${id} AND archived_at IS NULL`;
          return yield* get(id);
        }),
      ),
    unarchive: (id) =>
      mutate(
        "unarchive",
        { id },
        Effect.gen(function* () {
          yield* get(id);
          yield* sql`UPDATE project_labels SET archived_at = NULL, updated_at = ${yield* now} WHERE label_id = ${id} AND archived_at IS NOT NULL`;
          return yield* get(id);
        }),
      ),
    linkRepository: (input) => repository(input, true),
    unlinkRepository: (input) => repository(input, false),
    linkSource: (input) => sourceLink(input, true),
    unlinkSource: (input) => sourceLink(input, false),
    setProjectChat: (input) =>
      mutate(
        "setProjectChat",
        input,
        Effect.gen(function* () {
          yield* get(input.id);
          yield* sql`UPDATE project_labels SET project_chat_thread_id = ${input.threadId}, updated_at = ${yield* now} WHERE label_id = ${input.id}`;
          return yield* get(input.id);
        }),
      ),
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
  });
});
export const layer = Layer.effect(ProjectLabelService, make);
