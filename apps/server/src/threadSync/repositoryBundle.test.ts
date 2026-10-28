import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { exportBundle, importBundle, withFullBundleFallback } from "./repositoryBundle.ts";

const layer = Git.layer.pipe(
  Layer.provideMerge(Config.layerTest("/tmp", { prefix: "task-bundles" })),
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "moves a local commit and its result branch without uncommitted edits, preserving divergent local branches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git.GitVcsDriver;
      const source = yield* fs.makeTempDirectoryScoped();
      const target = yield* fs.makeTempDirectoryScoped();
      const execute = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({ cwd, args, operation: "bundle-test" });
      yield* execute(source, ["init", "--initial-branch=main"]);
      yield* execute(target, ["init", "--initial-branch=main"]);
      yield* fs.writeFileString(path.join(source, "committed.txt"), "source commit");
      yield* execute(source, ["add", "."]);
      yield* execute(source, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "local commit",
      ]);
      const first = (yield* git.resolveCommit({ cwd: source, revision: "HEAD" })).commitSha;
      yield* fs.writeFileString(path.join(source, "uncommitted.txt"), "must stay here");
      const bundle = yield* exportBundle(source, first);
      yield* importBundle(target, bundle);
      expect((yield* execute(target, ["show", `${first}:committed.txt`])).stdout).toBe(
        "source commit",
      );
      expect(
        (yield* Effect.result(execute(target, ["show", `${first}:uncommitted.txt`])))._tag,
      ).toBe("Failure");
      yield* importBundle(target, bundle, "c/remote-result");
      expect(
        (yield* git.resolveCommit({ cwd: target, revision: "c/remote-result" })).commitSha,
      ).toBe(first);
      yield* execute(source, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "result",
      ]);
      const second = (yield* git.resolveCommit({ cwd: source, revision: "HEAD" })).commitSha;
      const result = yield* exportBundle(source, second);
      yield* importBundle(target, result, "c/remote-result");
      expect(
        (yield* git.resolveCommit({ cwd: target, revision: "c/remote-result" })).commitSha,
      ).toBe(second);
      // Returning an older result must never force a local branch backwards.
      expect((yield* Effect.result(importBundle(target, bundle, "c/remote-result")))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* git.resolveCommit({ cwd: target, revision: "c/remote-result" })).commitSha,
      ).toBe(second);
      expect(
        (yield* execute(source, ["for-each-ref", "--format=%(refname)", "refs/cogenly/delegate/"]))
          .stdout,
      ).toBe("");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "fetches shared origin history and bundles only unpublished commits; legacy targets retain full bundles",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git.GitVcsDriver;
      const origin = yield* fs.makeTempDirectoryScoped();
      const source = yield* fs.makeTempDirectoryScoped();
      const target = yield* fs.makeTempDirectoryScoped();
      const execute = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({ cwd, args, operation: "delta-test" });
      const commit = (cwd: string, message: string) =>
        execute(cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-am",
          message,
        ]);
      yield* execute(origin, ["init", "--initial-branch=main"]);
      yield* fs.writeFileString(path.join(origin, "shared.txt"), "remote history");
      yield* execute(origin, ["add", "."]);
      yield* commit(origin, "shared");
      const base = (yield* git.resolveCommit({ cwd: origin, revision: "HEAD" })).commitSha;
      yield* execute(source, ["clone", origin, "."]);
      yield* execute(target, ["clone", origin, "."]);
      const pushed = yield* exportBundle(source, base, true);
      expect(pushed.prerequisites).toEqual([base]);
      expect(pushed.base64).toBe("");
      // Objects already present must work without any origin or network.
      yield* execute(target, ["remote", "set-url", "origin", path.join(target, "offline")]);
      yield* importBundle(target, pushed);
      yield* execute(source, ["remote", "set-url", "origin", path.join(source, "offline")]);
      yield* fs.writeFileString(path.join(source, "local.txt"), "unpublished");
      yield* execute(source, ["add", "."]);
      yield* commit(source, "local");
      const head = (yield* git.resolveCommit({ cwd: source, revision: "HEAD" })).commitSha;
      const delta = yield* exportBundle(source, head, true);
      expect(delta.prerequisites).toEqual([base]);
      expect(delta.base64.length).toBeGreaterThan(0);
      yield* importBundle(target, delta);
      expect((yield* execute(target, ["show", `${head}:local.txt`])).stdout).toBe("unpublished");
      // Fetching/importing objects leaves the destination checkout and branch alone.
      expect((yield* git.resolveCommit({ cwd: target, revision: "HEAD" })).commitSha).toBe(base);
      const legacy = yield* exportBundle(source, head);
      expect(legacy.prerequisites).toBeUndefined();
      const empty = yield* fs.makeTempDirectoryScoped();
      yield* execute(empty, ["init"]);
      yield* importBundle(empty, legacy);
      expect((yield* execute(empty, ["show", `${head}:shared.txt`])).stdout).toBe("remote history");
      // No origin means even a new peer gets a self-contained bundle.
      const fallback = yield* exportBundle(origin, base, true);
      expect(fallback.prerequisites).toBeUndefined();
      // A target that cannot fetch the prerequisite fails clearly before accepting the delta.
      const missing = yield* fs.makeTempDirectoryScoped();
      yield* execute(missing, ["init"]);
      const rejected = yield* Effect.result(importBundle(missing, delta));
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure")
        expect(rejected.failure.reason).toBe("missing-prerequisites");
      // Launch and branch-return imports both recover with a bounded full bundle.
      for (const branch of [undefined, "c/returned-result"]) {
        const destination = yield* fs.makeTempDirectoryScoped();
        yield* execute(destination, ["init"]);
        const attempts: boolean[] = [];
        yield* withFullBundleFallback(true, (remoteDelta) =>
          Effect.gen(function* () {
            attempts.push(remoteDelta);
            yield* importBundle(
              destination,
              yield* exportBundle(source, head, remoteDelta),
              branch,
            );
          }),
        );
        expect(attempts).toEqual([true, false]);
        expect((yield* execute(destination, ["show", `${head}:local.txt`])).stdout).toBe(
          "unpublished",
        );
        if (branch !== undefined)
          expect((yield* git.resolveCommit({ cwd: destination, revision: branch })).commitSha).toBe(
            head,
          );
      }
      // Too many boundaries must never escape the wire contract's 256 cap.
      const capped = yield* exportBundle(source, head, true).pipe(
        Effect.provideService(Git.GitVcsDriver, {
          ...git,
          execute: (input) =>
            input.operation === "delegate-origin-boundary"
              ? Effect.succeed({
                  stdout: Array.from({ length: 257 }, () => `-${base}`).join("\n"),
                  stderr: "",
                  exitCode: 0,
                })
              : git.execute(input),
        }),
      );
      expect(capped.prerequisites).toBeUndefined();
      yield* importBundle(missing, capped);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps the 32 MiB guard on the delta rather than shared repository history", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* Git.GitVcsDriver;
    const origin = yield* fs.makeTempDirectoryScoped();
    const source = yield* fs.makeTempDirectoryScoped();
    const target = yield* fs.makeTempDirectoryScoped();
    const execute = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ cwd, args, operation: "large-delta-test" });
    const commit = (cwd: string) =>
      execute(cwd, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-am",
        "commit",
      ]);
    yield* execute(origin, ["init", "--initial-branch=main"]);
    // Disable pack compression so this fixture proves the byte limit without random data.
    yield* fs.writeFile(path.join(origin, "large.bin"), new Uint8Array(33 * 1024 * 1024));
    yield* execute(origin, ["add", "."]);
    yield* commit(origin);
    yield* execute(source, ["clone", origin, "."]);
    yield* execute(target, ["clone", origin, "."]);
    yield* execute(source, ["config", "pack.compression", "0"]);
    yield* execute(source, ["config", "pack.window", "0"]);
    yield* commit(source);
    const head = (yield* git.resolveCommit({ cwd: source, revision: "HEAD" })).commitSha;
    const legacy = yield* Effect.result(exportBundle(source, head));
    expect(legacy._tag).toBe("Failure");
    if (legacy._tag === "Failure") expect(legacy.failure.reason).toBe("too-large");
    const delta = yield* exportBundle(source, head, true);
    expect(delta.prerequisites).toHaveLength(1);
    const empty = yield* fs.makeTempDirectoryScoped();
    yield* execute(empty, ["init"]);
    const fullRetry = yield* Effect.result(
      withFullBundleFallback(true, (remoteDelta) =>
        Effect.gen(function* () {
          yield* importBundle(empty, yield* exportBundle(source, head, remoteDelta));
        }),
      ),
    );
    expect(fullRetry._tag).toBe("Failure");
    if (fullRetry._tag === "Failure") expect(fullRetry.failure.reason).toBe("too-large");
    expect(delta.base64.length).toBeLessThan(4096);
    yield* importBundle(target, delta);
    expect((yield* execute(target, ["cat-file", "-s", `${head}:large.bin`])).stdout.trim()).toBe(
      String(33 * 1024 * 1024),
    );
    // A large unpublished blob still trips the guard on the new path.
    yield* fs.writeFile(path.join(source, "unpublished.bin"), new Uint8Array(34 * 1024 * 1024));
    yield* execute(source, ["add", "."]);
    yield* commit(source);
    const largeHead = (yield* git.resolveCommit({ cwd: source, revision: "HEAD" })).commitSha;
    const oversized = yield* Effect.result(exportBundle(source, largeHead, true));
    expect(oversized._tag).toBe("Failure");
    if (oversized._tag === "Failure") expect(oversized.failure.reason).toBe("too-large");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
