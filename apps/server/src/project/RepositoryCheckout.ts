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
  type ProjectLabelRemoveCheckoutInput,
  type ProjectLabelRemoveCheckoutResult,
} from "@t3tools/contracts";
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
  }
>()("cogenly-server/project/RepositoryCheckout") {}

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
          const clone = yield* clones.get(link.repositoryId);
          const ready =
            clone?.phase !== "running" &&
            ((yield* hasOwnCheckout(project.workspaceRoot)) ||
              (yield* entriesOf(project.workspaceRoot)).length > 0);
          if (!ready) yield* startInPlace(project, repositoryName, remote);
          return { repositoryId: link.repositoryId };
        }

        const { dir } = yield* folders.ensureForLabel(label).pipe(Effect.mapError(fail));
        const destination = projectRepositoryDirectory(dir, repositoryName, path);
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

  const gitOut = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    vcs
      .execute({ operation, cwd, args, timeoutMs: 30_000 })
      .pipe(Effect.map((result) => result.stdout.trim()));

  /**
   * Refuses when the checkout holds work found nowhere else: other
   * worktrees, uncommitted or stashed changes, or commits on no remote.
   */
  const assertNothingLocal = (repositoryId: ProjectId, repositoryName: string, cwd: string) =>
    Effect.gen(function* () {
      const refuse = (reason: RepositoryCheckoutError["reason"], detail?: string) =>
        new RepositoryCheckoutError({
          repositoryId,
          repositoryName,
          reason,
          ...(detail === undefined ? {} : { detail }),
        });
      const worktrees = (yield* gitOut(cwd, "RepositoryCheckout.worktrees", [
        "worktree",
        "list",
        "--porcelain",
      ]))
        .split("\n\n")
        .filter((entry) => entry.startsWith("worktree ") && !/\nprunable/.test(entry));
      if (worktrees.length > 1) return yield* refuse("has_worktrees", `${worktrees.length - 1}`);
      const status = yield* gitOut(cwd, "RepositoryCheckout.status", ["status", "--porcelain"]);
      const stashes = yield* gitOut(cwd, "RepositoryCheckout.stashes", ["stash", "list"]);
      if (status.length > 0 || stashes.length > 0) return yield* refuse("uncommitted_changes");
      const unpushed = yield* gitOut(cwd, "RepositoryCheckout.unpushed", [
        "log",
        "--branches",
        "--not",
        "--remotes",
        "--oneline",
        "-n",
        "1",
      ]);
      if (unpushed.length > 0) return yield* refuse("unpushed_commits");
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
        if (yield* hasOwnCheckout(root))
          yield* assertNothingLocal(link.repositoryId, repositoryName, root);
        else if ((yield* entriesOf(root)).length > 0)
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

  return RepositoryCheckout.of({
    ensureCheckout,
    checkoutRepository,
    resolveRepository,
    removeCheckout,
  });
});

export const layer = Layer.effect(RepositoryCheckout, make);
