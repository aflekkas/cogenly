import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  REMOTE_REPOSITORY_ID_PREFIX,
  RepositoryCheckoutError,
  SourceControlProviderKind,
  isRemoteRepositoryPlaceholder,
  type ProjectCloneSnapshot,
  type ProjectLabelCheckoutRepositoryInput,
  type ProjectLabelCheckoutRepositoryResult,
  type ProjectLabelId,
  type ProjectLabelAdoptRepositoryInput,
  type ProjectLabelAdoptRepositoryResult,
  type ProjectLabelRemoveCheckoutInput,
  type ProjectLabelWithRepositories,
  PROJECT_REPOSITORIES_SEGMENT,
  type ProjectLabelRemoveCheckoutResult,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { projectRepositoryDirectory, repositoryDirectoryNameFromRemote } from "./ProjectsRoot.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { normalizeRepositoryRemote, repositoryDirectoryName } from "./RepositoryRemote.ts";

export { RepositoryCheckoutError };

/**
 * A repository's checkout on this machine.
 *
 * `ensureCheckout` guarantees a repository launch lands in a real checkout:
 * an existing checkout passes, a missing or empty folder with a known remote
 * is cloned in place through the tracked clone flow (progress on the
 * project-clone subscription, the machine's usual GitHub auth), a folder that
 * already has files is left to launch as before, and a missing checkout with
 * no known remote fails with what to do instead. User files are never touched.
 *
 * `checkoutRepository` is the explicit "clone it here" for a repository a
 * project links by remote, including one linked from another machine that
 * has no record here yet (a `remote:` placeholder).
 */
export class RepositoryCheckout extends Context.Service<
  RepositoryCheckout,
  {
    readonly ensureCheckout: (
      repositoryId: ProjectId,
    ) => Effect.Effect<void, RepositoryCheckoutError>;
    /**
     * Starts (or joins) the clone of a linked remote into
     * `<project folder>/<directoryName>` and returns this machine's
     * repository id without waiting for it. A placeholder link is rebound to
     * the new record in one transaction; a checkout already on disk at the
     * destination with the same remote is adopted instead of cloned; a ready
     * checkout is returned as is. Idempotent, so callers may retry.
     */
    readonly checkoutRepository: (
      input: ProjectLabelCheckoutRepositoryInput,
    ) => Effect.Effect<ProjectLabelCheckoutRepositoryResult, RepositoryCheckoutError>;
    /**
     * This machine's record for a repository id: a real id as is, a `remote:`
     * placeholder through checkoutRepository on the project that links it.
     */
    readonly resolveRepository: (
      repositoryId: ProjectId,
    ) => Effect.Effect<ProjectLabelCheckoutRepositoryResult, RepositoryCheckoutError>;
    /**
     * Deletes this machine's checkout of a linked repository and keeps the
     * link and record: the link reads `missing` and clones back in place.
     * Refuses a local-only repository (nothing could bring it back), a turn
     * running in it, other worktrees, and any work found nowhere else.
     */
    readonly removeCheckout: (
      input: ProjectLabelRemoveCheckoutInput,
    ) => Effect.Effect<ProjectLabelRemoveCheckoutResult, RepositoryCheckoutError>;
    /**
     * Moves a linked repository's checkout to `<project>/repos/<directoryName>`
     * (from anywhere: `~/Documents/Projects/spawn-platform` becomes
     * `<project>/repos/platform`), runs `git worktree repair` so its
     * worktrees follow, and repoints the record's workspace root. Refuses
     * while a turn runs in it or a worktree lives inside it.
     */
    readonly adoptRepository: (
      input: ProjectLabelAdoptRepositoryInput,
    ) => Effect.Effect<ProjectLabelAdoptRepositoryResult, RepositoryCheckoutError>;
    /**
     * Re-derives where the project's checkouts belong after its owner
     * changed: every checkout already under its `repos/` that no longer sits
     * at its directory name is moved there through adoptRepository. Checkouts
     * kept outside the project folder are left for the user to move. A
     * repository that cannot move now is skipped and logged.
     */
    readonly relocateProjectRepositories: (
      labelId: ProjectLabelId,
    ) => Effect.Effect<{ readonly moved: ReadonlyArray<ProjectId> }, RepositoryCheckoutError>;
  }
>()("cogenly-server/project/RepositoryCheckout") {}

// Ignored output an install or build recreates. Anything else git ignores
// (an `.env`, local data, editor settings) exists only on this machine.
const REBUILDABLE_IGNORED = new Set([
  ".DS_Store",
  ".cache",
  ".eslintcache",
  ".expo",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".turbo",
  ".venv",
  ".vercel",
  "DerivedData",
  "Pods",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

/** Whether a `git status --ignored` path is rebuildable output (`apps/web/dist/`). */
export function isRebuildableIgnored(entry: string): boolean {
  const name = entry.replace(/\/+$/, "").split("/").at(-1) ?? "";
  return REBUILDABLE_IGNORED.has(name) || name.endsWith(".log") || name.endsWith(".tsbuildinfo");
}

/** Turns a stored remote back into clone input for the tracked clone flow. */
export function cloneInputForRemote(remote: string): {
  readonly provider?: SourceControlProviderKind;
  readonly repository?: string;
  readonly remoteUrl?: string;
} {
  const trimmed = remote.trim();
  // A URL, an scp-style remote, or a filesystem path (a local bare remote)
  // is given to git as-is.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    return { remoteUrl: trimmed };
  }
  // The stored normalized form is `host/owner/repo`. GitHub goes through
  // the provider so the clone uses the machine's GitHub auth and preferred
  // transport, exactly like a fresh project clone.
  const [host, ...rest] = trimmed.split("/");
  if (host === "github.com" && rest.length === 2) {
    return {
      provider: SourceControlProviderKind.make("github"),
      repository: rest.join("/"),
    };
  }
  return { remoteUrl: `https://${trimmed}` };
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const folders = yield* ProjectLabelFolders.ProjectLabelFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const home = yield* HostProcess.HomeDirectory;
  const identities = yield* Effect.serviceOption(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
  );
  // One checkout decision at a time: two clicks on a not-cloned row must not
  // start two clones into the same folder under two new records.
  const checkoutLock = yield* Semaphore.make(1);

  // The folder's own `.git` (a directory, or a file for a linked worktree),
  // not `git rev-parse`: an empty folder inside some other repository is
  // inside a work tree, yet holds no checkout of this repository.
  const hasOwnCheckout = (workspaceRoot: string) =>
    fileSystem.exists(path.join(workspaceRoot, ".git")).pipe(
      Effect.flatMap((exists) =>
        exists ? git.isRepository(workspaceRoot) : Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => false),
    );

  const entriesOf = (dir: string) =>
    fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const isInside = (candidate: string, dir: string) => {
    const relative = path.relative(path.resolve(dir), path.resolve(candidate));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  /**
   * Whether `destination` would land inside another checkout under the
   * project's `repos/` (a home-owner repository named like another linked
   * owner, `repos/acme` vs `repos/acme/site`), which git would see as its files.
   */
  const insideOtherCheckout = (destination: string, projectDir: string) =>
    Effect.gen(function* () {
      const repos = path.resolve(projectDir, PROJECT_REPOSITORIES_SEGMENT);
      let current = path.dirname(path.resolve(destination));
      while (isInside(current, repos)) {
        if (
          yield* fileSystem
            .exists(path.join(current, ".git"))
            .pipe(Effect.orElseSucceed(() => false))
        )
          return true;
        current = path.dirname(current);
      }
      return false;
    });

  /** Whether two paths name the same folder (a case-only rename on APFS). */
  const sameFolder = (left: string, right: string) =>
    Effect.gen(function* () {
      const [a, b] = yield* Effect.all([fileSystem.stat(left), fileSystem.stat(right)]);
      return (
        Option.isSome(a.ino) &&
        Option.isSome(b.ino) &&
        a.ino.value === b.ino.value &&
        a.dev === b.dev
      );
    }).pipe(Effect.orElseSucceed(() => false));

  const waitForClone = (repositoryId: ProjectId) =>
    Effect.scoped(
      clones.stream.pipe(
        Stream.map((snapshots) => snapshots.find((clone) => clone.projectId === repositoryId)),
        Stream.filter((clone) => clone === undefined || clone.phase !== "running"),
        Stream.runHead,
      ),
    );

  const settledFailure = (
    repositoryId: ProjectId,
    repositoryName: string,
    settled: ProjectCloneSnapshot | undefined,
  ) =>
    settled !== undefined && settled.phase !== "done"
      ? Effect.fail(
          new RepositoryCheckoutError({
            repositoryId,
            repositoryName,
            reason: "clone_failed",
            detail:
              settled.phase === "cancelled"
                ? "The clone was cancelled."
                : (settled.error ?? "The repository could not be cloned."),
          }),
        )
      : Effect.void;

  const storage = (repositoryId: ProjectId, repositoryName: string) => (cause: unknown) =>
    new RepositoryCheckoutError({ repositoryId, repositoryName, reason: "storage", cause });

  // Re-resolve the folder's repository (it may have been cached as an
  // enclosing repo while empty), then refresh the project record.
  const afterClone = (repositoryId: ProjectId, workspaceRoot: string) =>
    (Option.isSome(identities)
      ? identities.value.resolve(workspaceRoot, { refresh: true })
      : Effect.void
    ).pipe(
      Effect.andThen(
        projects.update({
          commandId: CommandId.make(`repository-checkout-cloned:${repositoryId}`),
          projectId: repositoryId,
        }),
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  /**
   * Starts the clone of `remote` into an existing record's missing or empty
   * folder, retries a failed one, and joins a running one. Does not wait.
   */
  const startInPlace = Effect.fn("RepositoryCheckout.startInPlace")(function* (
    project: { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string },
    repositoryName: string,
    remote: string,
  ) {
    const repositoryId = project.id;
    const existing = yield* clones.get(repositoryId);
    if (existing?.phase === "running") return;
    if (existing === null || existing.phase === "done") {
      // A finished clone's snapshot lingers briefly and would read as this
      // clone's own: drop it (a done checkout is never deleted) and start over.
      if (existing?.phase === "done") {
        // A concurrent caller's clone may just have landed it.
        if (yield* hasOwnCheckout(project.workspaceRoot)) return;
        yield* clones.discard(repositoryId);
      }
      // The check above and this start are not atomic: a concurrent launch
      // for the same repository can claim the clone in between. Its start
      // conflict is not a failure — the caller waits for that clone instead.
      const started = yield* Effect.result(
        clones
          .start(
            {
              projectId: repositoryId,
              title: project.title,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              destinationPath: project.workspaceRoot,
              ...cloneInputForRemote(remote),
            },
            {
              // The project record already exists; only the checkout is missing.
              createProject: () => Effect.void,
              onCloned: () => afterClone(repositoryId, project.workspaceRoot),
            },
            // Server-initiated re-clone of a stored remote: local remotes that
            // came from a previous clone or the repository's own config are allowed.
            { cloneCaller: "owner" },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new RepositoryCheckoutError({
                  repositoryId,
                  repositoryName,
                  reason: "clone_failed",
                  detail:
                    cause._tag === "SourceControlRepositoryError" ? cause.detail : cause.message,
                  cause,
                }),
            ),
          ),
      );
      if (started._tag === "Failure") {
        const concurrent = yield* clones.get(repositoryId);
        // Only a conflict with this repository's own clone means "wait for
        // it"; a destination owned by another project stays an error.
        if (
          concurrent === null ||
          concurrent.phase === "failed" ||
          concurrent.phase === "cancelled"
        )
          return yield* started.failure;
      }
      return;
    }
    const retried = yield* clones.retry(repositoryId).pipe(
      Effect.mapError(
        (cause) =>
          new RepositoryCheckoutError({
            repositoryId,
            repositoryName,
            reason: "clone_failed",
            detail: cause.detail,
            cause,
          }),
      ),
    );
    if (!retried) {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "clone_failed",
        detail: existing.error ?? "The previous clone did not finish.",
      });
    }
  });

  const readLink = (labelId: ProjectLabelId, remote: string) =>
    Effect.gen(function* () {
      const placeholder = ProjectId.make(`${REMOTE_REPOSITORY_ID_PREFIX}${remote}`);
      const fallbackName = repositoryDirectoryNameFromRemote({ remoteUrl: remote }) || remote;
      const { label } = yield* labels.read(labelId).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryCheckoutError({
              repositoryId: placeholder,
              repositoryName: fallbackName,
              reason: cause.reason === "not_found" ? "not_found" : "storage",
              cause,
            }),
        ),
      );
      const link = label.repositories?.find((candidate) => candidate.remote === remote);
      if (link === undefined)
        return yield* new RepositoryCheckoutError({
          repositoryId: placeholder,
          repositoryName: fallbackName,
          reason: "not_linked",
        });
      return { label, link, repositoryName: link.directoryName ?? fallbackName };
    });

  /** Clones a record's empty folder in place, unless its clone runs or something is there. */
  const resumeRecord = (
    project: { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string },
    repositoryName: string,
    remote: string,
  ) =>
    Effect.gen(function* () {
      const clone = yield* clones.get(project.id);
      const ready =
        clone?.phase !== "running" &&
        ((yield* hasOwnCheckout(project.workspaceRoot)) ||
          (yield* entriesOf(project.workspaceRoot)).length > 0);
      if (!ready) yield* startInPlace(project, repositoryName, remote);
    });

  const checkoutRepository: RepositoryCheckout["Service"]["checkoutRepository"] = (input) =>
    checkoutLock.withPermits(1)(
      Effect.gen(function* () {
        const remote = normalizeRepositoryRemote(input.remote) ?? input.remote.trim();
        const { label, link, repositoryName } = yield* readLink(input.labelId, remote);
        const fail = storage(link.repositoryId, repositoryName);

        if (!isRemoteRepositoryPlaceholder(link.repositoryId)) {
          const project = Option.getOrUndefined(
            yield* projects.getById(link.repositoryId).pipe(Effect.mapError(fail)),
          );
          if (project === undefined)
            return yield* new RepositoryCheckoutError({
              repositoryId: link.repositoryId,
              repositoryName,
              reason: "not_found",
            });
          yield* resumeRecord(project, repositoryName, remote);
          return { repositoryId: link.repositoryId };
        }

        const { dir } = yield* folders.ensureForLabel(label).pipe(Effect.mapError(fail));
        const destination = projectRepositoryDirectory(dir, repositoryName, path);
        // A record already at the destination is one an earlier checkout made
        // before binding it failed: bind that one rather than make a second.
        const earlier = Option.getOrUndefined(
          yield* projects.getByWorkspaceRoot(destination).pipe(Effect.mapError(fail)),
        );
        if (earlier !== undefined) {
          if (yield* hasOwnCheckout(destination)) {
            const identity = Option.isSome(identities)
              ? yield* identities.value.resolve(destination, { refresh: true })
              : null;
            const found = normalizeRepositoryRemote(identity?.locator.remoteUrl);
            if (found !== null && found !== normalizeRepositoryRemote(remote))
              return yield* new RepositoryCheckoutError({
                repositoryId: link.repositoryId,
                repositoryName,
                reason: "destination_taken",
                detail: destination,
              });
          }
          yield* resumeRecord(earlier, repositoryName, remote);
          yield* labels
            .bindRepositoryCheckout({ labelId: label.id, remote, repositoryId: earlier.id })
            .pipe(Effect.mapError(fail));
          return { repositoryId: earlier.id };
        }
        if (yield* insideOtherCheckout(destination, dir))
          return yield* new RepositoryCheckoutError({
            repositoryId: link.repositoryId,
            repositoryName,
            reason: "destination_taken",
            detail: destination,
          });
        const createRecord = (repositoryId: ProjectId) =>
          projects
            .create({
              commandId: CommandId.make(`repository-checkout-create:${repositoryId}`),
              projectId: repositoryId,
              title: repositoryName,
              workspaceRoot: destination,
              createWorkspaceRootIfMissing: true,
            })
            .pipe(Effect.asVoid);
        const repositoryId = ProjectId.make(
          yield* crypto.randomUUIDv4().pipe(Effect.mapError(fail)),
        );

        if (yield* hasOwnCheckout(destination)) {
          // Already on disk (cloned by hand, or left by an earlier install):
          // adopt it when it is this repository, never clone over it.
          const identity = Option.isSome(identities)
            ? yield* identities.value.resolve(destination, { refresh: true })
            : null;
          const found = normalizeRepositoryRemote(identity?.locator.remoteUrl);
          if (found !== null && found !== normalizeRepositoryRemote(remote))
            return yield* new RepositoryCheckoutError({
              repositoryId: link.repositoryId,
              repositoryName,
              reason: "destination_taken",
              detail: destination,
            });
          yield* createRecord(repositoryId).pipe(Effect.mapError(fail));
        } else {
          if ((yield* entriesOf(destination)).length > 0)
            return yield* new RepositoryCheckoutError({
              repositoryId: link.repositoryId,
              repositoryName,
              reason: "destination_taken",
              detail: destination,
            });
          yield* clones
            .start(
              {
                projectId: repositoryId,
                title: repositoryName,
                createdAt: DateTime.formatIso(yield* DateTime.now),
                destinationPath: destination,
                ...cloneInputForRemote(remote),
              },
              {
                createProject: () =>
                  createRecord(repositoryId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationDispatchCommandError({
                          message: "Failed to create the repository record.",
                          cause,
                        }),
                    ),
                  ),
                onCloned: () => afterClone(repositoryId, destination),
              },
              { cloneCaller: "owner" },
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new RepositoryCheckoutError({
                    repositoryId: link.repositoryId,
                    repositoryName,
                    reason: "clone_failed",
                    detail:
                      cause._tag === "SourceControlRepositoryError" ? cause.detail : cause.message,
                    cause,
                  }),
              ),
            );
        }
        // The record exists (and any clone runs): swap the placeholder for it.
        // A failed clone keeps the record, so the row reads `failed` and the
        // next checkout retries in place instead of starting over.
        yield* labels
          .bindRepositoryCheckout({ labelId: label.id, remote, repositoryId })
          .pipe(Effect.mapError(fail));
        return { repositoryId };
      }),
    );

  const resolveRepository: RepositoryCheckout["Service"]["resolveRepository"] = Effect.fn(
    "RepositoryCheckout.resolveRepository",
  )(function* (repositoryId) {
    if (!isRemoteRepositoryPlaceholder(repositoryId)) return { repositoryId };
    const remote = repositoryId.slice(REMOTE_REPOSITORY_ID_PREFIX.length);
    const { labels: all } = yield* labels
      .list()
      .pipe(Effect.mapError(storage(repositoryId, remote)));
    const owner = all.find((label) =>
      (label.repositories ?? []).some((link) => link.repositoryId === repositoryId),
    );
    if (owner === undefined)
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName: remote,
        reason: "not_found",
      });
    return yield* checkoutRepository({ labelId: owner.id, remote });
  });

  const ensureCheckout: RepositoryCheckout["Service"]["ensureCheckout"] = Effect.fn(
    "RepositoryCheckout.ensureCheckout",
  )(function* (repositoryId) {
    // A repository linked from another machine has no record here: clone it
    // into its project folder first, then wait on that clone like any other.
    if (isRemoteRepositoryPlaceholder(repositoryId))
      return yield* ensureCheckout((yield* resolveRepository(repositoryId)).repositoryId);

    const project = yield* projects.getById(repositoryId).pipe(
      Effect.mapError(storage(repositoryId, repositoryId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new RepositoryCheckoutError({
                repositoryId,
                repositoryName: repositoryId,
                reason: "not_found",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const workspaceRoot = project.workspaceRoot;
    const repositoryName = repositoryDirectoryName(workspaceRoot) ?? project.title ?? repositoryId;

    // A clone git is still running has already created `.git` but has not
    // checked out any files, so the filesystem shortcuts below would pass
    // against a half-made checkout. Wait for this repository's own clone
    // in the tracker before trusting anything on disk.
    const activeClone = yield* clones.get(repositoryId);
    if (activeClone?.phase === "running") {
      const settled = Option.getOrUndefined(yield* waitForClone(repositoryId));
      yield* settledFailure(repositoryId, repositoryName, settled);
      if (yield* hasOwnCheckout(workspaceRoot)) {
        return;
      }
      // The clone left the tracker (or finished without a checkout):
      // fall through and let the normal flow judge what is on disk.
    }

    if (yield* hasOwnCheckout(workspaceRoot)) {
      return;
    }

    const exists = yield* fileSystem
      .exists(workspaceRoot)
      .pipe(Effect.mapError(storage(repositoryId, repositoryName)));
    if (exists) {
      const entries = yield* fileSystem
        .readDirectory(workspaceRoot)
        .pipe(Effect.mapError(storage(repositoryId, repositoryName)));
      // A folder with files launches as it always did: a monorepo subfolder,
      // or a plain folder filed as a repository. Only a missing or empty
      // checkout is cloned, so nothing here can touch the user's files.
      if (entries.length > 0) return;
    }

    const { labels: allLabels } = yield* labels
      .list()
      .pipe(Effect.mapError(storage(repositoryId, repositoryName)));
    const link = allLabels
      .flatMap((label) => label.repositories ?? [])
      .find((candidate) => candidate.repositoryId === repositoryId);
    const remote = link?.remote?.trim() ? link.remote.trim() : null;
    if (remote === null) {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "no_remote",
      });
    }

    yield* startInPlace(project, repositoryName, remote);

    const settled = Option.getOrUndefined(yield* waitForClone(repositoryId));
    yield* settledFailure(repositoryId, repositoryName, settled);
    if (!(yield* hasOwnCheckout(workspaceRoot))) {
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason: "clone_failed",
        detail: "The clone finished without producing a checkout.",
      });
    }
  });

  /** Refuses while a turn runs in any thread of the repository. */
  const assertIdle = (repositoryId: ProjectId, repositoryName: string) =>
    sql`SELECT 1 AS one FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE t.project_id = ${repositoryId} AND t.deleted_at IS NULL
        AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1`.pipe(
      Effect.mapError(storage(repositoryId, repositoryName)),
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.void
          : Effect.fail(
              new RepositoryCheckoutError({
                repositoryId,
                repositoryName,
                reason: "thread_active",
              }),
            ),
      ),
    );

  const gitRun = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    vcs.execute({ operation, cwd, args, timeoutMs: 30_000, allowNonZeroExit: true });
  const gitOut = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    vcs
      .execute({ operation, cwd, args, timeoutMs: 30_000 })
      .pipe(Effect.map((result) => result.stdout.trim()));

  /**
   * Refuses when the checkout holds work found nowhere else: other
   * worktrees, uncommitted, untracked, stashed or git-ignored files (other
   * than rebuildable output), commits or tags on no remote, a detached HEAD
   * on no remote, and the same inside every checked-out submodule. Flags are
   * explicit so a repository's own config (`status.showUntrackedFiles=no`,
   * ignored submodules) cannot hide anything.
   */
  const assertNothingLocal = (
    repositoryId: ProjectId,
    repositoryName: string,
    cwd: string,
    checkWorktrees = true,
  ): Effect.Effect<void, RepositoryCheckoutError> =>
    Effect.gen(function* () {
      const refuse = (reason: RepositoryCheckoutError["reason"], detail?: string) =>
        new RepositoryCheckoutError({
          repositoryId,
          repositoryName,
          reason,
          ...(detail === undefined ? {} : { detail }),
        });
      if (checkWorktrees) {
        const worktrees = (yield* gitOut(cwd, "RepositoryCheckout.worktrees", [
          "worktree",
          "list",
          "--porcelain",
        ]))
          .split("\n\n")
          .filter((entry) => entry.startsWith("worktree ") && !/\nprunable/.test(entry));
        if (worktrees.length > 1) return yield* refuse("has_worktrees", `${worktrees.length - 1}`);
      }
      const status = yield* gitOut(cwd, "RepositoryCheckout.status", [
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
        "--ignored=traditional",
        "--ignore-submodules=none",
      ]);
      const entries = status.split("\0").filter((entry) => entry.length > 0);
      if (entries.some((entry) => !entry.startsWith("!! ")))
        return yield* refuse("uncommitted_changes");
      const localOnly = entries
        .map((entry) => entry.slice(3))
        .filter((entry) => !isRebuildableIgnored(entry));
      if (localOnly.length > 0)
        return yield* refuse(
          "uncommitted_changes",
          `git ignores files that exist only here: ${localOnly.slice(0, 5).join(", ")}${localOnly.length > 5 ? ", …" : ""}`,
        );
      const stashes = yield* gitOut(cwd, "RepositoryCheckout.stashes", ["stash", "list"]);
      if (stashes.length > 0) return yield* refuse("uncommitted_changes");
      // A detached HEAD is on no branch; an unborn one has nothing to lose.
      const head = yield* gitRun(cwd, "RepositoryCheckout.head", [
        "rev-parse",
        "--verify",
        "-q",
        "HEAD",
      ]);
      const unpushed = yield* gitOut(cwd, "RepositoryCheckout.unpushed", [
        "rev-list",
        "-n",
        "1",
        "--branches",
        "--tags",
        ...(head.exitCode === 0 && head.stdout.trim().length > 0 ? ["HEAD"] : []),
        "--not",
        "--remotes",
      ]);
      if (unpushed.length > 0) return yield* refuse("unpushed_commits");
      if (
        yield* fileSystem
          .exists(path.join(cwd, ".gitmodules"))
          .pipe(Effect.orElseSucceed(() => false))
      ) {
        const submodules = (yield* gitOut(cwd, "RepositoryCheckout.submodules", [
          "submodule",
          "foreach",
          "--quiet",
          "--recursive",
          `printf '%s\\0' "$toplevel/$sm_path"`,
        ]))
          .split("\0")
          .filter((entry) => entry.length > 0);
        for (const submodule of submodules)
          yield* assertNothingLocal(repositoryId, repositoryName, submodule, false);
      }
    }).pipe(
      Effect.catchTags({
        GitCommandError: (cause) => Effect.fail(storage(repositoryId, repositoryName)(cause)),
      }),
    );

  const removeCheckout: RepositoryCheckout["Service"]["removeCheckout"] = (input) =>
    checkoutLock.withPermits(1)(
      Effect.gen(function* () {
        const { label } = yield* labels
          .read(input.labelId)
          .pipe(Effect.mapError(storage(input.repositoryId, input.repositoryId)));
        const link = label.repositories?.find(
          (candidate) => candidate.repositoryId === input.repositoryId,
        );
        const repositoryName = link?.directoryName ?? input.repositoryId;
        if (link === undefined)
          return yield* new RepositoryCheckoutError({
            repositoryId: input.repositoryId,
            repositoryName,
            reason: "not_linked",
          });
        if (isRemoteRepositoryPlaceholder(link.repositoryId)) return { removed: false };
        if (link.remote === null)
          return yield* new RepositoryCheckoutError({
            repositoryId: link.repositoryId,
            repositoryName,
            reason: "no_remote",
          });
        const project = Option.getOrUndefined(
          yield* projects
            .getById(link.repositoryId)
            .pipe(Effect.mapError(storage(link.repositoryId, repositoryName))),
        );
        if (project === undefined) return { removed: false };
        yield* assertIdle(link.repositoryId, repositoryName);
        // A clone still running is cancelled, which deletes its partial checkout.
        if ((yield* clones.get(link.repositoryId))?.phase === "running") {
          yield* clones.cancel(link.repositoryId);
          yield* labels.notifyCheckoutChanged;
          return { removed: true };
        }
        const root = project.workspaceRoot;
        if (!(yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false))))
          return { removed: false };
        // A record pointing at a folder that holds other projects (the
        // projects root, a project folder, a home directory) is never a
        // checkout to delete, whatever git says about it.
        const realRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
        const projectsRoot = yield* folders.projectsRoot.pipe(Effect.orElseSucceed(() => null));
        const { dir: projectDir } = yield* folders
          .dirForLabel(label)
          .pipe(Effect.orElseSucceed(() => ({ dir: null })));
        const sheltering = [home, projectsRoot, projectDir].flatMap((dir) =>
          dir === null ? [] : [path.resolve(dir)],
        );
        if (
          [path.resolve(root), path.resolve(realRoot)].some(
            (candidate) =>
              path.parse(candidate).root === candidate ||
              sheltering.some((dir) => dir === candidate || isInside(dir, candidate)),
          )
        )
          return yield* new RepositoryCheckoutError({
            repositoryId: link.repositoryId,
            repositoryName,
            reason: "protected_folder",
            detail: root,
          });
        if (yield* hasOwnCheckout(root))
          yield* assertNothingLocal(link.repositoryId, repositoryName, root);
        else if (
          (yield* fileSystem
            .readDirectory(root)
            .pipe(Effect.mapError(storage(link.repositoryId, repositoryName)))).length > 0
        )
          // Files that are not a checkout of this repository cannot be proven safe to delete.
          return yield* new RepositoryCheckoutError({
            repositoryId: link.repositoryId,
            repositoryName,
            reason: "uncommitted_changes",
          });
        yield* fileSystem
          .remove(root, { recursive: true })
          .pipe(Effect.mapError(storage(link.repositoryId, repositoryName)));
        if (Option.isSome(identities))
          yield* identities.value.resolve(root, { refresh: true }).pipe(Effect.ignore);
        yield* labels.notifyCheckoutChanged;
        return { removed: true };
      }),
    );

  const adoptLink = Effect.fn("RepositoryCheckout.adoptLink")(function* (
    label: ProjectLabelWithRepositories,
    repositoryId: ProjectId,
  ) {
    const link = label.repositories?.find((candidate) => candidate.repositoryId === repositoryId);
    if (link === undefined || isRemoteRepositoryPlaceholder(repositoryId))
      return yield* new RepositoryCheckoutError({
        repositoryId,
        repositoryName: link?.directoryName ?? repositoryId,
        reason: "not_linked",
      });
    const project = Option.getOrUndefined(
      yield* projects
        .getById(repositoryId)
        .pipe(Effect.mapError(storage(repositoryId, repositoryId))),
    );
    const repositoryName =
      link.directoryName ??
      (project && repositoryDirectoryName(project.workspaceRoot)) ??
      repositoryId;
    const fail = storage(repositoryId, repositoryName);
    const refuse = (reason: RepositoryCheckoutError["reason"], detail?: string) =>
      new RepositoryCheckoutError({
        repositoryId,
        repositoryName,
        reason,
        ...(detail === undefined ? {} : { detail }),
      });
    if (project === undefined) return yield* refuse("not_found");
    const { dir } = yield* folders.ensureForLabel(label).pipe(Effect.mapError(fail));
    const source = path.resolve(project.workspaceRoot);
    const destination = path.resolve(projectRepositoryDirectory(dir, repositoryName, path));
    if (source === destination) return { moved: false, workspaceRoot: destination };
    yield* assertIdle(repositoryId, repositoryName);
    if ((yield* clones.get(repositoryId))?.phase === "running")
      return yield* refuse("move_failed", "it is still cloning");
    // Only a checkout of its own moves: a folder without `.git` may be a
    // subfolder of some other repository, which the move would tear out.
    if (!(yield* hasOwnCheckout(source)))
      return yield* refuse(
        "move_failed",
        "there is no checkout of its own on this machine to move",
      );
    if (yield* insideOtherCheckout(destination, dir))
      return yield* refuse("destination_taken", destination);
    // A worktree inside the folder would move with it under git's feet.
    const threadWorktrees = yield* sql<{ readonly worktree_path: string }>`
      SELECT json_extract(payload_json, '$.worktreePath') AS worktree_path
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(Effect.mapError(fail));
    const gitWorktrees = (yield* gitOut(source, "RepositoryCheckout.worktrees", [
      "worktree",
      "list",
      "--porcelain",
    ]).pipe(Effect.mapError(fail)))
      .split("\n")
      .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []));
    // git reports real paths; the record may hold a symlinked one.
    const realSource = yield* fileSystem.realPath(source).pipe(Effect.orElseSucceed(() => source));
    if (
      [...threadWorktrees.map((row) => row.worktree_path), ...gitWorktrees].some(
        (worktree) => isInside(worktree, source) || isInside(worktree, realSource),
      )
    )
      return yield* refuse("worktrees_inside");
    // On a case-insensitive disk `repos/Platform` and `repos/platform` are
    // one folder: a case-only rename goes through a temporary name.
    const caseOnly = yield* sameFolder(source, destination);
    if (
      !caseOnly &&
      (yield* fileSystem.exists(destination).pipe(Effect.orElseSucceed(() => true)))
    ) {
      // Only an empty folder gives way; a file, or one that cannot be read, stays.
      const info = yield* fileSystem.stat(destination).pipe(Effect.mapError(fail));
      const entries =
        info.type === "Directory"
          ? yield* fileSystem.readDirectory(destination).pipe(Effect.mapError(fail))
          : null;
      if (entries === null || entries.length > 0)
        return yield* refuse("destination_taken", destination);
      yield* fileSystem.remove(destination).pipe(Effect.mapError(fail));
    }
    yield* fileSystem
      .makeDirectory(path.dirname(destination), { recursive: true })
      .pipe(Effect.mapError(fail));
    const move = (from: string, to: string) =>
      caseOnly
        ? Effect.gen(function* () {
            const staging = `${to}.cogenly-move-${(yield* crypto.randomUUIDv4()).slice(0, 8)}`;
            yield* fileSystem.rename(from, staging);
            yield* fileSystem
              .rename(staging, to)
              .pipe(Effect.tapError(() => fileSystem.rename(staging, from).pipe(Effect.ignore)));
          })
        : fileSystem.rename(from, to);
    yield* move(source, destination).pipe(
      Effect.mapError((cause) => refuse("move_failed", cause.message)),
    );
    // Linked worktrees point back at the main checkout's `.git`; repair
    // rewrites both sides for the new location.
    const repair = (at: string) =>
      gitRun(at, "RepositoryCheckout.repairWorktrees", ["worktree", "repair"]).pipe(
        Effect.mapError((cause) => refuse("move_failed", cause.message)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(
                refuse("move_failed", result.stderr.trim() || "git worktree repair failed"),
              ),
        ),
      );
    // Anything failing after the rename puts the checkout back where the
    // record still says it is, and its worktrees with it.
    const rollback = move(destination, source).pipe(
      Effect.andThen(repair(source)),
      Effect.ignoreCause({ log: true }),
    );
    yield* repair(destination).pipe(Effect.tapError(() => rollback));
    const commandSuffix = yield* crypto.randomUUIDv4().pipe(Effect.mapError(fail));
    yield* projects
      .update({
        commandId: CommandId.make(`repository-adopt:${repositoryId}:${commandSuffix}`),
        projectId: repositoryId,
        workspaceRoot: destination,
      })
      .pipe(
        Effect.tapError(() => rollback),
        Effect.mapError((cause) => refuse("move_failed", cause.message)),
      );
    if (Option.isSome(identities)) {
      yield* identities.value.resolve(source, { refresh: true }).pipe(Effect.ignore);
      yield* identities.value.resolve(destination, { refresh: true }).pipe(Effect.ignore);
    }
    yield* labels.notifyCheckoutChanged;
    return { moved: true, workspaceRoot: destination };
  });

  const readLabel = (labelId: ProjectLabelId) =>
    labels.read(labelId).pipe(
      Effect.map(({ label }) => label),
      Effect.mapError(
        (cause) =>
          new RepositoryCheckoutError({
            repositoryId: ProjectId.make(labelId),
            repositoryName: labelId,
            reason: cause.reason === "not_found" ? "not_found" : "storage",
            cause,
          }),
      ),
    );

  const adoptRepository: RepositoryCheckout["Service"]["adoptRepository"] = (input) =>
    checkoutLock.withPermits(1)(
      readLabel(input.labelId).pipe(
        Effect.flatMap((label) => adoptLink(label, input.repositoryId)),
      ),
    );

  const relocateProjectRepositories: RepositoryCheckout["Service"]["relocateProjectRepositories"] =
    (labelId) =>
      checkoutLock.withPermits(1)(
        Effect.gen(function* () {
          const label = yield* readLabel(labelId);
          const { dir } = yield* folders
            .dirForLabel(label)
            .pipe(Effect.mapError(storage(ProjectId.make(labelId), label.name)));
          const repos = path.join(dir, PROJECT_REPOSITORIES_SEGMENT);
          const moved: Array<ProjectId> = [];
          for (const link of label.repositories ?? []) {
            if (isRemoteRepositoryPlaceholder(link.repositoryId) || link.directoryName === null)
              continue;
            const project = Option.getOrUndefined(
              yield* projects.getById(link.repositoryId).pipe(Effect.orElseSucceed(Option.none)),
            );
            if (project === undefined) continue;
            // The project folder was renamed (here, in Finder, or by a peer's
            // rename), taking the checkout with it: point the record at where
            // the checkout went, the derived place or the same spot in the
            // renamed folder.
            if (
              !(yield* fileSystem
                .exists(project.workspaceRoot)
                .pipe(Effect.orElseSucceed(() => true)))
            ) {
              const root = yield* folders.projectsRoot.pipe(Effect.orElseSucceed(() => null));
              const relative = root === null ? null : path.relative(root, project.workspaceRoot);
              const tail =
                relative === null || relative.startsWith("..") || path.isAbsolute(relative)
                  ? []
                  : relative.split(path.sep).slice(1);
              const candidates = [
                projectRepositoryDirectory(dir, link.directoryName, path),
                ...(tail.length > 0 ? [path.join(dir, ...tail)] : []),
              ];
              for (const candidate of candidates) {
                if (!(yield* hasOwnCheckout(candidate))) continue;
                // Only this repository's checkout: never repoint a record at
                // some other repository that happens to sit there.
                if (link.remote !== null && Option.isSome(identities)) {
                  const identity = yield* identities.value
                    .resolve(candidate, { refresh: true })
                    .pipe(Effect.orElseSucceed(() => null));
                  if (normalizeRepositoryRemote(identity?.locator.remoteUrl) !== link.remote)
                    continue;
                }
                const suffix = yield* crypto
                  .randomUUIDv4()
                  .pipe(Effect.orElseSucceed(() => "repoint"));
                const repointed = yield* projects
                  .update({
                    commandId: CommandId.make(`repository-repoint:${link.repositoryId}:${suffix}`),
                    projectId: link.repositoryId,
                    workspaceRoot: candidate,
                  })
                  .pipe(
                    Effect.as(true),
                    Effect.catch((cause) =>
                      Effect.logWarning("Project repository could not follow its renamed folder", {
                        repositoryId: link.repositoryId,
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
                if (repointed) moved.push(link.repositoryId);
                break;
              }
              continue;
            }
            if (!isInside(project.workspaceRoot, repos)) continue;
            const result = yield* adoptLink(label, link.repositoryId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Project repository could not follow its new folder name", {
                  repositoryId: link.repositoryId,
                  reason: error.reason,
                }),
              ),
              Effect.orElseSucceed(() => ({ moved: false })),
            );
            if (result.moved) moved.push(link.repositoryId);
          }
          return { moved };
        }),
      );

  return RepositoryCheckout.of({
    ensureCheckout,
    checkoutRepository,
    resolveRepository,
    removeCheckout,
    adoptRepository,
    relocateProjectRepositories,
  });
});

export const layer = Layer.effect(RepositoryCheckout, make);

/**
 * Keeps checkouts inside project folders where their derived names point:
 * after any project change (an owner linked or unlinked here, or synced from
 * another machine), every project's in-folder checkouts are relocated.
 */
export const layerRelocation = Layer.effectDiscard(
  Effect.gen(function* () {
    const checkouts = yield* RepositoryCheckout;
    const labels = yield* ProjectLabelService.ProjectLabelService;
    const changes = yield* labels.subscribeChanges;
    yield* changes.pipe(
      Stream.runForEach(() =>
        labels.list().pipe(
          Effect.flatMap(({ labels: all }) =>
            Effect.forEach(all, (label) => checkouts.relocateProjectRepositories(label.id), {
              discard: true,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
