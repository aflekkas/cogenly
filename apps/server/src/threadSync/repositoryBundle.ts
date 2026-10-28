import { type ThreadRepositoryBundle, ThreadRemoteError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Git from "../vcs/GitVcsDriver.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const isRemoteError = Schema.is(ThreadRemoteError);
const failed = (_cause: unknown) =>
  new ThreadRemoteError({
    reason: "needs-repository",
    detail: "The repository commit could not be transferred. Launch on this machine instead.",
  });

/** Retry a rejected delta once, retaining the full bundle's size guard. */
export const withFullBundleFallback = <A, R>(
  remoteDelta: boolean,
  transfer: (remoteDelta: boolean) => Effect.Effect<A, ThreadRemoteError, R>,
) =>
  transfer(remoteDelta).pipe(
    Effect.catchIf(
      (error) => remoteDelta && error.reason === "missing-prerequisites",
      () => transfer(false),
    ),
  );

/** A bounded bundle of one local commit; uncommitted files never travel. */
export const exportBundle = Effect.fn("RepositoryBundle.export")(function* (
  cwd: string,
  revision: string,
  remoteDelta = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temp = yield* fs.makeTempDirectoryScoped();
      const file = path.join(temp, "commit.bundle");
      const ref = `refs/cogenly/delegate/${path.basename(temp)}`;
      // Reuse known remote history without touching the user's tracking refs.
      const findPrerequisites = Effect.gen(function* () {
        const known = yield* git.execute({
          cwd,
          operation: "delegate-origin-refs",
          args: ["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/"],
        });
        const heads = known.stdout.trim().split("\n").filter(Boolean);
        if (heads.length === 0) return undefined;
        const reachable = yield* git.execute({
          cwd,
          operation: "delegate-origin-boundary",
          args: ["rev-list", "--boundary", revision, "--not", ...heads],
        });
        const lines = reachable.stdout.trim().split("\n").filter(Boolean);
        const boundaries = lines
          .filter((line) => line.startsWith("-"))
          .map((line) => line.slice(1));
        return lines.length === 0 ? [revision] : boundaries.length === 0 ? undefined : boundaries;
      });
      const prerequisites = remoteDelta
        ? yield* Effect.gen(function* () {
            const known = yield* findPrerequisites;
            if (known !== undefined) return known;
            // An optional refresh must not turn offline delegation into a long wait.
            yield* git.execute({
              cwd,
              operation: "delegate-origin-refresh",
              args: ["fetch", "--no-tags", "origin"],
              timeoutMs: 3_000,
            });
            return yield* findPrerequisites;
          }).pipe(
            Effect.map((commits) =>
              commits !== undefined && commits.length <= 256 ? commits : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      if (prerequisites?.includes(revision))
        return { revision, ref, base64: "", prerequisites } satisfies ThreadRepositoryBundle;
      yield* git.execute({
        cwd,
        operation: "delegate-bundle-ref",
        args: ["update-ref", ref, revision],
      });
      yield* git
        .execute({
          cwd,
          operation: "delegate-bundle-export",
          args: [
            "bundle",
            "create",
            file,
            ref,
            ...(prerequisites ?? []).map((commit) => `^${commit}`),
          ],
        })
        .pipe(
          Effect.ensuring(
            git
              .execute({
                cwd,
                operation: "delegate-bundle-cleanup",
                args: ["update-ref", "-d", ref],
              })
              .pipe(Effect.ignore),
          ),
        );
      if (Number((yield* fs.stat(file)).size) > MAX_BYTES)
        return yield* new ThreadRemoteError({
          reason: "too-large",
          detail: "The task's committed history exceeds the 32 MiB machine-transfer limit.",
        });
      return {
        revision,
        ref,
        base64: Buffer.from(yield* fs.readFile(file)).toString("base64"),
        ...(prerequisites === undefined ? {} : { prerequisites }),
      } satisfies ThreadRepositoryBundle;
    }),
  ).pipe(Effect.mapError((error) => (isRemoteError(error) ? error : failed(error))));
});

/** Fetches into the target's own clone before its launch prepares a worktree. */
export const importBundle = Effect.fn("RepositoryBundle.import")(function* (
  cwd: string,
  bundle: ThreadRepositoryBundle,
  branch?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const bytes = Buffer.from(bundle.base64, "base64");
  if (bytes.byteLength > MAX_BYTES) return yield* new ThreadRemoteError({ reason: "too-large" });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "commit.bundle");
      yield* fs.writeFile(file, bytes);
      if (branch !== undefined)
        yield* git.execute({
          cwd,
          operation: "delegate-result-branch",
          args: ["check-ref-format", `refs/heads/${branch}`],
        });
      if (bundle.prerequisites !== undefined) {
        yield* Effect.gen(function* () {
          const missing: string[] = [];
          for (const commit of bundle.prerequisites!) {
            const exists = yield* git
              .execute({
                cwd,
                operation: "delegate-origin-local",
                args: ["cat-file", "-e", `${commit}^{commit}`],
              })
              .pipe(Effect.isSuccess);
            if (!exists) missing.push(commit);
          }
          if (missing.length > 0)
            yield* git.execute({
              cwd,
              operation: "delegate-origin-fetch",
              args: ["fetch", "--no-tags", "--no-write-fetch-head", "origin", ...missing],
              timeoutMs: 3_000,
            });
          for (const commit of missing)
            yield* git.execute({
              cwd,
              operation: "delegate-origin-verify",
              args: ["cat-file", "-e", `${commit}^{commit}`],
            });
        }).pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "missing-prerequisites" })));
        if (bytes.byteLength === 0) {
          if (!bundle.prerequisites.includes(bundle.revision)) return yield* failed(undefined);
          if (branch !== undefined)
            yield* git.execute({
              cwd,
              operation: "delegate-origin-branch",
              args: [
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                ".",
                `${bundle.revision}:refs/heads/${branch}`,
              ],
            });
          return;
        }
      }
      yield* git
        .execute({
          cwd,
          operation: "delegate-bundle-verify",
          args: ["bundle", "verify", file],
        })
        .pipe(
          Effect.mapError((error) =>
            bundle.prerequisites === undefined
              ? failed(error)
              : new ThreadRemoteError({ reason: "missing-prerequisites" }),
          ),
        );
      yield* git.execute({
        cwd,
        operation: "delegate-bundle-fetch",
        args: [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          file,
          branch === undefined ? bundle.ref : `${bundle.ref}:refs/heads/${branch}`,
        ],
      });
      yield* git.execute({
        cwd,
        operation: "delegate-bundle-commit",
        args: ["cat-file", "-e", `${bundle.revision}^{commit}`],
      });
    }),
  ).pipe(Effect.mapError((error) => (isRemoteError(error) ? error : failed(error))));
});
