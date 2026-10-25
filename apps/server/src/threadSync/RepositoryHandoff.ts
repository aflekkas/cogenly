import {
  type OrchestrationV2AppThread,
  type ThreadHandoffRepository,
  type ThreadMoveBranch,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import { exportBundle, importBundle } from "./repositoryBundle.ts";

const isRemoteError = Schema.is(ThreadRemoteError);

export class RepositoryHandoff extends Context.Service<
  RepositoryHandoff,
  {
    readonly source: (
      entry: OrchestrationV2AppThread,
      repositoryRoot?: string,
      dryRun?: boolean,
    ) => Effect.Effect<ThreadHandoffRepository | null, ThreadRemoteError>;
    readonly verify: (
      worktreePath: string,
      repository: ThreadHandoffRepository,
    ) => Effect.Effect<void, ThreadRemoteError>;
    readonly prepare: (input: {
      readonly cwd: string;
      readonly worktreePath: string | null;
      readonly repository: ThreadHandoffRepository;
      readonly dryRun?: boolean;
    }) => Effect.Effect<
      { readonly worktreePath: string | null; readonly branch?: ThreadMoveBranch },
      ThreadRemoteError
    >;
  }
>()("cogenly-server/threadSync/RepositoryHandoff") {}

const make = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const bundleContext = yield* Effect.context<
    Git.GitVcsDriver | FileSystem.FileSystem | Path.Path
  >();
  const failed = () =>
    new ThreadRemoteError({
      reason: "needs-repository",
      detail:
        "Could not prepare the source's pushed commit. Check the destination repository and retry the move.",
    });
  const source = Effect.fn("RepositoryHandoff.source")(
    function* (entry: OrchestrationV2AppThread, repositoryRoot?: string, dryRun = false) {
      if (entry.worktreePath === null || entry.branch === null) return null;
      const cwd = (yield* fs.exists(entry.worktreePath))
        ? entry.worktreePath
        : (repositoryRoot ?? entry.worktreePath);
      // Even --leave-local-changes hands off the pushed revision, never unpushed edits or commits.
      const upstream = (yield* git.execute({
        cwd,
        operation: "handoff-upstream",
        args: [
          "for-each-ref",
          "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${entry.branch}`,
        ],
      })).stdout
        .trim()
        .split("\0");
      const [ref, remote, remoteRef] = upstream;
      if (!ref || !remote || !remoteRef)
        return yield* new ThreadRemoteError({
          reason: "local-changes",
          detail: "The branch has no pushed revision to move. Push it and set its upstream first.",
        });
      const revision = (yield* git.resolveCommit({ cwd, revision: ref })).commitSha;
      return {
        branch: entry.branch,
        revision,
        remoteRef,
        ...(remote === "." && !dryRun
          ? {
              bundle: yield* exportBundle(cwd, revision).pipe(Effect.provideContext(bundleContext)),
            }
          : {}),
      } satisfies ThreadHandoffRepository;
    },
    Effect.mapError((error) => (isRemoteError(error) ? error : failed())),
  );

  const verify = Effect.fn("RepositoryHandoff.verify")(
    function* (worktreePath: string, repository: ThreadHandoffRepository) {
      const head = (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha;
      const branch = (yield* git.resolveCommit({
        cwd: worktreePath,
        revision: `refs/heads/${repository.branch}`,
      })).commitSha;
      if (head !== repository.revision || branch !== repository.revision) return yield* failed();
    },
    Effect.mapError((error) => (isRemoteError(error) ? error : failed())),
  );

  const prepare = Effect.fn("RepositoryHandoff.prepare")(
    function* ({
      cwd,
      repository,
      dryRun = false,
      worktreePath,
    }: Parameters<RepositoryHandoff["Service"]["prepare"]>[0]) {
      const { branch, revision } = repository;
      const ref = `refs/heads/${branch}`;
      const execute = (args: ReadonlyArray<string>, allowNonZeroExit = false, root = cwd) =>
        git.execute({ cwd: root, operation: "handoff-repository", args, allowNonZeroExit });
      yield* execute(["check-ref-format", ref]);
      yield* execute(["check-ref-format", repository.remoteRef]);
      if (!repository.remoteRef.startsWith("refs/heads/")) return yield* failed();
      const remoteTracking = `refs/remotes/origin/${repository.remoteRef.slice("refs/heads/".length)}`;
      if (!dryRun) {
        if (repository.bundle !== undefined) {
          if (repository.bundle.revision !== revision) return yield* failed();
          yield* importBundle(cwd, repository.bundle).pipe(Effect.provideContext(bundleContext));
        } else {
          // Fetch into a remote-tracking ref; inspect the local branch before changing it.
          yield* execute([
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "origin",
            `+${repository.remoteRef}:${remoteTracking}`,
          ]);
        }
        yield* execute(["cat-file", "-e", `${revision}^{commit}`]);
      }
      const local = yield* execute(["rev-parse", "--verify", "--quiet", ref], true);
      if (local.exitCode !== 0 && local.exitCode !== 1) return yield* failed();
      const previous = local.exitCode === 0 ? local.stdout.trim() : undefined;
      const worktrees = (yield* execute(["worktree", "list", "--porcelain", "-z"])).stdout;
      const occupied = worktrees
        .split("\0\0")
        .find((record) => record.split("\0").includes(`branch ${ref}`));
      const checkedPath = occupied
        ?.split("\0")
        .find((field) => field.startsWith("worktree "))
        ?.slice(9);
      const atTarget =
        checkedPath !== undefined &&
        worktreePath !== null &&
        path.resolve(checkedPath) === path.resolve(worktreePath);
      const dirty =
        checkedPath === undefined
          ? false
          : (yield* execute(["status", "--porcelain", "--untracked-files=all"], false, checkedPath))
              .stdout.length > 0;
      const ancestor =
        previous === undefined || previous === revision
          ? undefined
          : yield* execute(["merge-base", "--is-ancestor", previous, revision], true);
      if (!dryRun && ancestor !== undefined && ancestor.exitCode !== 0 && ancestor.exitCode !== 1)
        return yield* failed();
      const action: ThreadMoveBranch["action"] =
        previous === undefined
          ? "create"
          : previous === revision
            ? "unchanged"
            : ancestor?.exitCode === 0
              ? "fast-forward"
              : ancestor?.exitCode === 1
                ? "preserve"
                : "verify";
      // A worktree elsewhere (or one with edits) must keep both its HEAD and its index intact.
      const preserveCheckout = checkedPath !== undefined && (!atTarget || dirty);
      const suffix = `${DateTime.toEpochMillis(yield* DateTime.now)}`;
      const preservedBranch =
        action === "preserve" || preserveCheckout ? `preserved/${branch}-${suffix}` : undefined;
      const result: ThreadMoveBranch = {
        branch,
        revision,
        action,
        ...(preservedBranch === undefined ? {} : { preservedBranch }),
      };
      if (dryRun) return { branch: result, worktreePath };
      if (preservedBranch !== undefined && previous !== undefined) {
        if (checkedPath !== undefined) {
          yield* execute(["branch", "-m", branch, preservedBranch]);
          yield* execute(["update-ref", ref, revision, ""]);
        } else {
          // Preserve and replace in one ref transaction; concurrent updates fail rather than lose work.
          yield* git.execute({
            cwd,
            operation: "handoff-preserve",
            args: ["update-ref", "--stdin"],
            stdin: `start\ncreate refs/heads/${preservedBranch} ${previous}\nupdate ${ref} ${revision} ${previous}\nprepare\ncommit\n`,
          });
        }
      } else if (previous !== revision) {
        if (checkedPath !== undefined)
          yield* execute(["merge", "--ff-only", "--no-edit", revision], false, checkedPath);
        else yield* execute(["update-ref", ref, revision, previous ?? ""]);
      }
      if (repository.bundle === undefined)
        yield* execute(["branch", `--set-upstream-to=${remoteTracking}`, "--", branch]);
      // Never reuse an unrelated or preserved worktree at the old path.
      if (
        worktreePath !== null &&
        (yield* fs.exists(worktreePath)) &&
        !(atTarget && preservedBranch === undefined)
      )
        worktreePath = `${worktreePath}-handoff-${suffix}`;
      if (worktreePath !== null && !(atTarget && preservedBranch === undefined)) {
        yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
        yield* execute(["worktree", "add", "--", worktreePath, branch]);
        const marker = (yield* execute(
          ["rev-parse", "--git-path", "cogenly-dependencies-pruned"],
          false,
          worktreePath,
        )).stdout.trim();
        yield* fs.writeFileString(
          path.resolve(worktreePath, marker),
          "Setup required before next turn.\n",
        );
      }
      const actual = (yield* git.resolveCommit({
        cwd: worktreePath ?? cwd,
        revision: worktreePath === null ? ref : "HEAD",
      })).commitSha;
      if (actual !== revision) return yield* failed();
      return { branch: result, worktreePath };
    },
    lock.withPermits(1),
    Effect.mapError((error) => (isRemoteError(error) ? error : failed())),
  );
  return RepositoryHandoff.of({ source, prepare, verify });
});

export const layer = Layer.effect(RepositoryHandoff, make);
