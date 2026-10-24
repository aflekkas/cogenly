import {
  ProjectId,
  ProjectLabelError,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ProjectSourceLink,
  REMOTE_REPOSITORY_ID_PREFIX,
  projectHomeOwner,
  repositoryDirectoryNameFor,
  repositoryRemoteParts,
  ThreadProjectLabel,
  type ProjectLabelCreateInput,
  type ProjectLabelRepositoryCheckout,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

import * as SharedState from "../sync/SharedState.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { normalizeRepositoryRemote, repositoryDirectoryName } from "../project/RepositoryRemote.ts";
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
      input: ProjectLabelRepository & {
        /**
         * The repository's remote as known by the caller (a clone that has
         * not landed yet cannot be read from disk). Stored normalized at
         * link time so a failed clone still leaves a recoverable remote.
         */
        readonly remote?: string | null | undefined;
      },
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    readonly unlinkRepository: (
      input: ProjectLabelRepository,
    ) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
    /**
     * Points a linked remote at this machine's checkout record, in one
     * transaction: the `remote:` placeholder (or nothing, when it vanished)
     * becomes `repositoryId`, and scheduled tasks bound to the placeholder
     * follow it. RepositoryCheckout calls it once the record exists; the
     * synced project data does not change, since it names repositories by
     * remote and directory name.
     */
    /**
     * The project's home owner (its linked GitHub owner), recording the
     * connected account's login as that link when the project has none, so
     * the folders it derives are the same on every machine. Null when there
     * is neither.
     */
    readonly ensureHomeOwner: (
      id: ProjectLabelId,
    ) => Effect.Effect<string | null, ProjectLabelError>;
    readonly bindRepositoryCheckout: (input: {
      readonly labelId: ProjectLabelId;
      readonly remote: string;
      readonly repositoryId: ProjectId;
    }) => Effect.Effect<{ label: ProjectLabelWithRepositories }, ProjectLabelError>;
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
>()("cogenly-server/projectLabels/ProjectLabelService") {}

const isProjectLabelError = Schema.is(ProjectLabelError);
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectId)),
);
const decodeRepositoryLinks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        repositoryId: ProjectId,
        remote: Schema.NullOr(Schema.String),
        directoryName: Schema.NullOr(Schema.String),
        workspaceRoot: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);
type StoredRepositoryLink = {
  readonly repositoryId: ProjectId;
  readonly remote: string | null;
  readonly directoryName: string | null;
  /** This machine's checkout path; null for a `remote:` placeholder. */
  readonly workspaceRoot: string | null;
};
const decodeSourceLinkRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ kind: Schema.String, owner: Schema.String, repo: Schema.String })),
  ),
);
const decodeSourceLink = Schema.decodeUnknownOption(ProjectSourceLink);
const decodeLabel = Schema.decodeUnknownEffect(ProjectLabelWithRepositories);
const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);
/** `repos/` path of a link: derived from its remote, else the checkout's folder name. */
const repositoryDirectoryNameOf = (
  remote: string | null,
  workspaceRoot: string | null,
  homeOwner: string | null,
) =>
  remote !== null
    ? repositoryDirectoryNameFor(remote, homeOwner)
    : workspaceRoot === null
      ? null
      : repositoryDirectoryName(workspaceRoot);
const decodeTag = Schema.decodeUnknownEffect(ThreadProjectLabel);
const encodeAudit = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shared = yield* SharedState.SharedState;
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
    , (SELECT json_group_array(json(link)) FROM (SELECT json_object('repositoryId', repository_id, 'remote', remote, 'directoryName', directory_name, 'workspaceRoot', (SELECT p.workspace_root FROM projection_projects p WHERE p.project_id = r.repository_id AND p.deleted_at IS NULL)) AS link FROM label_repositories r WHERE r.label_id = l.label_id ORDER BY repository_id)) AS repositoryLinks
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
            const repositoryLinks = yield* backfillRepositoryLinks(
              yield* decodeRepositoryLinks(row.repositoryLinks),
              projectHomeOwner(sourceLinks),
            );
            const checkouts = yield* Effect.forEach(repositoryLinks, checkoutState);
            return yield* decodeLabel({
              ...row,
              color: row.color ?? undefined,
              description: row.description ?? undefined,
              archivedAt: row.archivedAt ?? undefined,
              instructions: row.instructions ?? "",
              repositoryIds,
              repositories: repositoryLinks.map((link, index) => ({
                repositoryId: link.repositoryId,
                remote: link.remote || null,
                directoryName: link.directoryName || null,
                checkout: checkouts[index],
              })),
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
            if (
              typeof result === "object" &&
              result !== null &&
              "label" in result &&
              typeof result.label === "object" &&
              result.label !== null &&
              "id" in result.label &&
              typeof result.label.id === "string" &&
              [
                "create",
                "update",
                "archive",
                "unarchive",
                "linkRepository",
                "unlinkRepository",
                "linkSource",
                "unlinkSource",
              ].includes(operation)
            ) {
              yield* shared.capture("project", result.label.id);
            }
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
    extra: Stream.Stream<void> = Stream.empty,
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
          Stream.mergeAll(
            [Stream.fromSubscription(subscription), shared.changes, deletions, extra],
            {
              concurrency: "unbounded",
            },
          ).pipe(Stream.mapEffect(read)),
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
  // Links written before portable identity (or by a link whose checkout had
  // no readable remote yet) backfill lazily on read: the remote comes from
  // the checkout's git remote when it can be read. A repo with no remote
  // stays null (local-only) and keeps its folder name. The resolver caches,
  // so repeat reads of a local-only repo do not spawn git every time. The
  // directory name is re-derived every read (the project's owner may have
  // changed, or a peer may have sent another), and a stored one that
  // disagrees is corrected, so the synced shape follows the rule too.
  const backfillRepositoryLinks = (
    links: ReadonlyArray<StoredRepositoryLink>,
    homeOwner: string | null,
  ) =>
    Effect.forEach(links, (link) =>
      Effect.gen(function* () {
        const workspaceRoot = link.workspaceRoot;
        const identity =
          link.remote === null &&
          Option.isSome(identities) &&
          typeof workspaceRoot === "string" &&
          workspaceRoot.length > 0
            ? yield* identities.value.resolve(workspaceRoot)
            : null;
        const remote =
          link.remote ??
          (identity === null ? null : normalizeRepositoryRemote(identity.locator.remoteUrl));
        const directoryName =
          repositoryDirectoryNameOf(remote, workspaceRoot, homeOwner) ?? link.directoryName;
        if (remote !== link.remote || directoryName !== link.directoryName) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE label_repositories SET remote=${remote},directory_name=${directoryName} WHERE repository_id=${link.repositoryId}`;
              const labels = yield* sql<{
                label_id: string;
              }>`SELECT label_id FROM label_repositories WHERE repository_id=${link.repositoryId}`;
              for (const row of labels)
                yield* shared.capture("project", row.label_id).pipe(
                  Effect.catchTags({
                    SharedStateError: (error) =>
                      Effect.logWarning("Project repository backfill capture failed", {
                        reason: error.reason,
                      }),
                  }),
                );
            }),
          );
        }
        return { ...link, remote, directoryName };
      }),
    );
  // Optional like the resolver: memory-database tests have neither disk nor
  // clones, and every linked repository with a record then reads as ready.
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const clones = yield* Effect.serviceOption(ProjectCloneTracker.ProjectCloneTracker);
  // Mirrors what RepositoryCheckout.ensureCheckout would clone: a folder with
  // its own `.git`, or any files at all (a monorepo subfolder, a plain
  // folder), is ready; a missing or empty one is not.
  const checkoutState = (
    link: StoredRepositoryLink,
  ): Effect.Effect<ProjectLabelRepositoryCheckout> =>
    Effect.gen(function* () {
      const clone = Option.isNone(clones) ? null : yield* clones.value.get(link.repositoryId);
      if (clone?.phase === "running") return "cloning";
      if (clone?.phase === "failed" || clone?.phase === "cancelled") return "failed";
      if (link.workspaceRoot === null) return "not_cloned";
      if (Option.isNone(fileSystem)) return "ready";
      const fs = fileSystem.value;
      if (yield* fs.exists(`${link.workspaceRoot}/.git`).pipe(Effect.orElseSucceed(() => false)))
        return "ready";
      const entries = yield* fs
        .readDirectory(link.workspaceRoot)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      return entries.length > 0 ? "ready" : "missing";
    });
  // Clone phases change what `checkout` reads; progress ticks do not.
  const clonePhaseChanges: Stream.Stream<void> = Option.isNone(clones)
    ? Stream.empty
    : clones.value.stream.pipe(
        Stream.map((snapshots) =>
          snapshots
            .map((clone) => `${clone.projectId}:${clone.phase}`)
            .sort()
            .join("\n"),
        ),
        Stream.changes,
        Stream.drop(1),
        Stream.map(() => undefined),
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
  // The connected GitHub account's login, read once: the home owner of a
  // project that links no owner. Optional like the resolver; null when
  // GitHub is not connected or cannot be reached.
  const github = yield* Effect.serviceOption(GitHubRest.GitHubRest);
  const viewer = yield* Ref.make<string | null>(null);
  const viewerLogin: Effect.Effect<string | null> = Effect.gen(function* () {
    const cached = yield* Ref.get(viewer);
    if (cached !== null || Option.isNone(github)) return cached;
    const response = yield* github.value.rest({
      host: "github.com",
      operation: "projectHomeOwner",
      path: "user",
    });
    if (response.status !== 200) return null;
    const login = Option.getOrNull(decodeViewer(response.body))?.login ?? null;
    if (login !== null) yield* Ref.set(viewer, login);
    return login;
  }).pipe(Effect.orElseSucceed(() => null));
  const ensureHomeOwner = (id: ProjectLabelId) =>
    Effect.gen(function* () {
      const { label } = yield* get(id);
      const current = projectHomeOwner(label.sourceLinks);
      if (current !== null || label.archivedAt !== undefined) return current;
      const login = yield* viewerLogin;
      const link =
        login === null
          ? undefined
          : Option.getOrUndefined(decodeSourceLink({ kind: "github-owner", owner: login }));
      if (link === undefined) return null;
      yield* sourceLink({ id, link }, true);
      return login;
    });
  const repository = (
    input: ProjectLabelRepository & { readonly remote?: string | null | undefined },
    link: boolean,
  ) =>
    mutate(
      link ? "linkRepository" : "unlinkRepository",
      input,
      Effect.gen(function* () {
        const previous = yield* sql<{
          label_id: string;
        }>`SELECT label_id FROM label_repositories WHERE repository_id=${input.repositoryId}`;
        const { label } = yield* get(input.labelId);
        if (link && !label.repositoryIds.includes(input.repositoryId))
          yield* readActive(input.labelId);
        if (link) {
          const rows = yield* sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id = ${input.repositoryId} AND deleted_at IS NULL`;
          if (!rows.length) return yield* missing("repository");
          // Portable identity, filled now so the link names the repository by
          // remote (null when local-only) and its project-relative directory.
          // A resolve that cannot read a remote yet never erases a stored one.
          const workspaceRoot = rows[0]?.workspace_root;
          const identity =
            Option.isNone(identities) || typeof workspaceRoot !== "string"
              ? null
              : yield* identities.value.resolve(workspaceRoot);
          const remote =
            normalizeRepositoryRemote(input.remote) ??
            (identity === null ? null : normalizeRepositoryRemote(identity.locator.remoteUrl));
          const owners = yield* sql<{
            owner: string;
          }>`SELECT owner FROM label_source_links WHERE label_id = ${input.labelId} AND kind = 'github-owner'`;
          const directoryName = repositoryDirectoryNameOf(
            remote,
            typeof workspaceRoot === "string" ? workspaceRoot : null,
            projectHomeOwner(owners.map((row) => ({ kind: "github-owner", owner: row.owner }))),
          );
          yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${input.labelId}, ${input.repositoryId}, ${remote}, ${directoryName}) ON CONFLICT(repository_id) DO UPDATE SET label_id = excluded.label_id, remote = COALESCE(excluded.remote, label_repositories.remote), directory_name = COALESCE(excluded.directory_name, label_repositories.directory_name)`;
          yield* autoAddRepositorySourceLink(input.labelId, input.repositoryId);
        } else
          yield* sql`DELETE FROM label_repositories WHERE label_id = ${input.labelId} AND repository_id = ${input.repositoryId}`;
        if (previous[0] && previous[0].label_id !== input.labelId)
          yield* shared.capture("project", previous[0].label_id);
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
        // Only filing into an archived project is refused: unfiling, moving
        // out, and re-filing where the thread already is stay allowed.
        const current = (yield* tags(input.threadId)).labels[0]?.labelId ?? null;
        if (input.folderId !== null)
          yield* (current === input.folderId ? get : readActive)(input.folderId);
        // Re-home instead of fork: the same thread is re-filed, and its next
        // turn follows the filing. RuntimePolicy resolves a filed chat's cwd
        // to the project folder (an unfiled chat keeps its scratch folder),
        // and ProviderTurnStartService starts a fresh provider session with a
        // portable context handoff when a thread's cwd changes, for every
        // adapter. What must not happen is moving a turn in flight, so a
        // thread with an active run refuses until that run settles.
        if (input.folderId !== current) {
          const active = yield* sql`SELECT 1 AS one FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = ${input.threadId}
              AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1`;
          if (active.length > 0)
            return yield* new ProjectLabelError({
              operation: "moveThread",
              reason: "thread_active",
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
    subscribeChanges: PubSub.subscribe(changes).pipe(
      Effect.map((subscription) =>
        Stream.merge(Stream.fromSubscription(subscription), shared.changes),
      ),
    ),
    list,
    read: get,
    readActive,
    subscribe: () => subscribe(list, membershipLifecycle, clonePhaseChanges),
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
        // Renaming moves the project folder on disk. A live thread whose
        // worktree lives inside it would keep the old path, and its next
        // turn would recreate a ghost worktree there, stranding the old
        // one's uncommitted changes. Refuse until those worktrees are gone:
        // rewriting stored worktree paths and repairing every repository's
        // worktree registrations is a larger change than this guard.
        if (input.name !== undefined && input.name !== previous && Option.isSome(folders)) {
          const folder = yield* folders.value
            .dirForLabel({ id: input.id, name: previous })
            .pipe(Effect.mapError(failure("update")));
          const rows = yield* sql<{ readonly worktree_path: string }>`
            SELECT json_extract(payload_json, '$.worktreePath') AS worktree_path
            FROM orchestration_v2_projection_threads
            WHERE deleted_at IS NULL
              AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
          `.pipe(Effect.mapError(failure("update")));
          const inside = `${folder.dir}/`;
          if (
            rows.some(
              (row) => row.worktree_path === folder.dir || row.worktree_path.startsWith(inside),
            )
          )
            return yield* new ProjectLabelError({
              operation: "update",
              reason: "worktrees_inside",
              projectName: previous,
            });
        }
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
          const rows = yield* sql`SELECT label_id FROM project_labels WHERE label_id=${id}`;
          yield* shared.write("project", id, {}, true);
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
    linkRepository: (input) =>
      Effect.gen(function* () {
        // The first GitHub repository of a project with no linked owner
        // makes the connected account its home owner, so its folder is
        // `repos/<repo>` on every machine rather than `repos/<owner>/<repo>`.
        const rows = yield* sql<{
          workspace_root: string;
        }>`SELECT workspace_root FROM projection_projects WHERE project_id = ${input.repositoryId} AND deleted_at IS NULL`.pipe(
          Effect.mapError(failure("linkRepository")),
        );
        const workspaceRoot = rows[0]?.workspace_root;
        const identity =
          Option.isNone(identities) || typeof workspaceRoot !== "string"
            ? null
            : yield* identities.value.resolve(workspaceRoot);
        const remote =
          normalizeRepositoryRemote(input.remote) ??
          (identity === null ? null : normalizeRepositoryRemote(identity.locator.remoteUrl));
        if (remote !== null && repositoryRemoteParts(remote)?.host === "github.com")
          yield* ensureHomeOwner(input.labelId).pipe(Effect.ignore);
        return yield* repository(input, true);
      }),
    ensureHomeOwner,
    unlinkRepository: (input) => repository(input, false),
    bindRepositoryCheckout: (input) =>
      mutate(
        "bindRepositoryCheckout",
        input,
        Effect.gen(function* () {
          const remote = normalizeRepositoryRemote(input.remote) ?? input.remote;
          const placeholder = `${REMOTE_REPOSITORY_ID_PREFIX}${remote}`;
          const { label } = yield* get(input.labelId);
          const directoryName = repositoryDirectoryNameFor(
            remote,
            projectHomeOwner(label.sourceLinks),
          );
          // Drop the placeholder first so the rebind never trips the
          // one-project-per-repository key, then file the checkout under the
          // same remote and directory name.
          yield* sql`DELETE FROM label_repositories WHERE label_id = ${input.labelId} AND repository_id = ${placeholder}`;
          yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${input.labelId}, ${input.repositoryId}, ${remote}, ${directoryName}) ON CONFLICT(repository_id) DO UPDATE SET label_id = excluded.label_id, remote = excluded.remote, directory_name = COALESCE(excluded.directory_name, label_repositories.directory_name)`;
          yield* sql`INSERT INTO shared_repository_checkouts(remote, repository_id, directory_name) VALUES (${remote}, ${input.repositoryId}, ${directoryName}) ON CONFLICT(remote) DO UPDATE SET repository_id = excluded.repository_id, directory_name = excluded.directory_name`;
          yield* sql`UPDATE scheduled_tasks SET project_id = ${input.repositoryId} WHERE project_id = ${placeholder}`;
          return yield* get(input.labelId);
        }),
      ),
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
export const layer = Layer.effect(ProjectLabelService, make).pipe(Layer.provide(SharedState.layer));
