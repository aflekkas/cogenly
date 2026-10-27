import { CheckpointRef } from "@cogenly/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";

const layer = VcsProcess.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live("checkpoint capture preserves the shared index used by the repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-split-index-" });
    const git = (args: ReadonlyArray<string>) =>
      runner.run({ operation: "test", command: "git", args, cwd });
    yield* git(["init", "--initial-branch=main"]);
    yield* fs.writeFileString(path.join(cwd, "file.txt"), "initial\n");
    yield* git(["add", "file.txt"]);
    yield* git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ]);
    yield* git(["config", "core.splitIndex", "true"]);
    yield* git(["config", "splitIndex.sharedIndexExpire", "now"]);
    yield* git(["update-index", "--split-index"]);
    yield* fs.writeFileString(path.join(cwd, "new.txt"), "new\n");

    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    expect((yield* git(["show", checkpointRef + ":new.txt"])).stdout).toBe("new\n");
    expect((yield* git(["ls-files", "--cached"])).stdout).toBe("file.txt\n");
    expect((yield* git(["diff", "--cached", "--name-only"])).stdout).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
