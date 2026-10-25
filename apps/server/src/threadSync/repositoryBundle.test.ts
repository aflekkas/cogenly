import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { exportBundle, importBundle } from "./repositoryBundle.ts";

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
