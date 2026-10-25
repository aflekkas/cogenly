import { ThreadRemoteError } from "@cogenly/contracts";
import { normalizeGitRemoteUrl } from "@cogenly/shared/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";

const isRemoteError = Schema.is(ThreadRemoteError);
const commitPattern = /^[a-f0-9]{40,64}$/;

/** Match the project's portable remote, which need not be named origin on this machine. */
const repositoryRemote = Effect.fn("Git.forkRemote")(function* (cwd: string, remote: string) {
  const git = yield* Git.GitVcsDriver;
  const names = (yield* git.execute({ cwd, args: ["remote"], operation: "fork-remote" })).stdout
    .trim()
    .split("\n");
  for (const name of names) {
    if (!name) continue;
    const url = (yield* git.execute({
      cwd,
      args: ["config", "--get", `remote.${name}.url`],
      operation: "fork-remote-url",
    })).stdout.trim();
    if (normalizeGitRemoteUrl(url) === remote) return name;
  }
  return yield* new ThreadRemoteError({
    reason: "needs-repository",
    detail: "This checkout has no remote matching the thread's repository. Its files were kept.",
  });
});

/** Read-only source inspection. Only a common ancestor of HEAD and a pushed ref may travel. */
export const forkSource = Effect.fn("Git.forkSource")(
  function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly allowLastPushed?: boolean;
  }) {
    const git = yield* Git.GitVcsDriver;
    const read = (args: ReadonlyArray<string>) =>
      git
        .execute({
          cwd: input.cwd,
          args,
          operation: "fork-source",
          allowNonZeroExit: true,
        })
        .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
    const remote = yield* repositoryRemote(input.cwd, input.remote);
    const head = yield* read(["rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = (yield* read(["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
    const dirty =
      (yield* git.execute({
        cwd: input.cwd,
        args: ["status", "--porcelain", "--untracked-files=normal"],
        operation: "fork-source-status",
      })).stdout.trim() !== "";
    const upstream = yield* read(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    const prefix = `refs/remotes/${remote}/`;
    const remoteRefs = (yield* read(["for-each-ref", "--format=%(refname)", prefix]))
      .split("\n")
      .filter(Boolean);
    const refs = [
      ...new Set(
        [
          upstream.startsWith(prefix) ? upstream : "",
          branch === null ? "" : `${prefix}${branch}`,
          ...remoteRefs,
        ].filter(Boolean),
      ),
    ];
    // A branch may have been pushed without setting an upstream, or HEAD may be detached.
    const containsHead =
      commitPattern.test(head) &&
      (yield* read(["for-each-ref", `--contains=${head}`, "--format=%(refname)", prefix])) !== "";
    let commit = containsHead ? head : "";
    if (!containsHead)
      for (const ref of refs) {
        const base = yield* read(["merge-base", head, ref]);
        if (!commitPattern.test(base)) continue;
        commit = base;
        break;
      }
    if (!commitPattern.test(head) || !commitPattern.test(commit))
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail:
          "No pushed commit could be verified. Push a branch before forking to another machine.",
      });
    const usedLastPushed = dirty || head !== commit;
    if (usedLastPushed && input.allowLastPushed !== true)
      return yield* new ThreadRemoteError({
        reason: "local-changes",
        detail: `${dirty ? "The source has uncommitted changes. " : ""}${head !== commit ? "The source has unpushed commits. " : ""}Commit and push your work first, or explicitly start from the last pushed commit (${commit.slice(0, 12)}). Local changes stay on the source machine.`,
      });
    return { remote: input.remote, branch, commit, usedLastPushed };
  },
  Effect.mapError((cause) =>
    isRemoteError(cause)
      ? cause
      : new ThreadRemoteError({
          reason: "needs-repository",
          detail: "The source repository's pushed state could not be verified.",
        }),
  ),
);

/** Reuse the same clean branch at the exact revision, or create it without resetting target work. */
export const forkCheckout = Effect.fn("Git.forkCheckout")(
  function* (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly branch: string | null;
    readonly commit: string;
  }) {
    const git = yield* Git.GitVcsDriver;
    const read = (cwd: string, args: ReadonlyArray<string>) =>
      git
        .execute({
          cwd,
          args,
          operation: "fork-checkout",
          allowNonZeroExit: true,
        })
        .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")));
    if (!commitPattern.test(input.commit))
      return yield* new ThreadRemoteError({ reason: "rejected" });
    const remote = yield* repositoryRemote(input.cwd, input.remote);
    yield* git.execute({
      cwd: input.cwd,
      operation: "fork-fetch",
      args: ["fetch", "--prune", remote],
    });
    const pushed = yield* read(input.cwd, [
      "for-each-ref",
      `--contains=${input.commit}`,
      "--format=%(refname)",
      `refs/remotes/${remote}/`,
    ]);
    if (pushed === "")
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail:
          "The selected commit is not available from this repository's remote. Push it before forking.",
      });
    if (input.branch !== null) {
      yield* git.execute({
        cwd: input.cwd,
        operation: "fork-branch",
        args: ["check-ref-format", `refs/heads/${input.branch}`],
      });
      for (const cwd of yield* git.listWorktreePaths(input.cwd)) {
        if ((yield* read(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) !== input.branch)
          continue;
        const head = yield* read(cwd, ["rev-parse", "HEAD"]);
        const dirty = (yield* git.execute({
          cwd,
          args: ["status", "--porcelain", "--untracked-files=normal"],
          operation: "fork-target-status",
        })).stdout.trim();
        if (head !== input.commit || dirty !== "")
          return yield* new ThreadRemoteError({
            reason: "needs-repository",
            detail:
              "The target already has this branch with different commits or uncommitted changes. Resolve that checkout first; no target files were replaced.",
          });
        return { branch: input.branch, worktreePath: cwd };
      }
    }
    const existing =
      input.branch === null
        ? ""
        : yield* read(input.cwd, ["rev-parse", "--verify", `refs/heads/${input.branch}^{commit}`]);
    if (existing !== "" && existing !== input.commit)
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail:
          "The target's branch differs from the selected pushed commit. Resolve it first; the branch was not reset.",
      });
    const result = yield* git.createWorktree({
      cwd: input.cwd,
      refName: existing === "" ? input.commit : input.branch!,
      newRefName: existing === "" ? (input.branch ?? undefined) : undefined,
      path: null,
    });
    return { branch: input.branch, worktreePath: result.worktree.path };
  },
  Effect.mapError((cause) =>
    isRemoteError(cause)
      ? cause
      : new ThreadRemoteError({
          reason: "needs-repository",
          detail:
            "The target could not check out the selected pushed commit. Its existing work was kept.",
        }),
  ),
);
