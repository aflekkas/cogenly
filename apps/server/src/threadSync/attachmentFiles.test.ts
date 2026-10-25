import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ServerConfig from "../config.ts";
import { startThreadMachine } from "./testkit.ts";
import { writeAttachmentFiles } from "./attachmentFiles.ts";

it.live(
  "an interrupted write never publishes a partial attachment and can be retried",
  () =>
    Effect.gen(function* () {
      const machine = yield* startThreadMachine("atomic-files", "computer");
      const fs = yield* machine.run(FileSystem.FileSystem);
      const path = yield* machine.run(Path.Path);
      const dir = (yield* machine.run(ServerConfig.ServerConfig)).attachmentsDir;
      const files = [{ name: "complete.txt", base64: Buffer.from("complete").toString("base64") }];
      const failing = FileSystem.FileSystem.of({
        ...fs,
        writeFile: (target, bytes) =>
          fs.writeFile(target, bytes.subarray(0, 2)).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFile",
                }),
              ),
            ),
          ),
      });
      const result = yield* Effect.result(
        machine.run(
          writeAttachmentFiles(files).pipe(Effect.provideService(FileSystem.FileSystem, failing)),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* fs.exists(path.join(dir, "complete.txt"))).toBe(false);
      yield* machine.run(writeAttachmentFiles(files));
      expect(yield* fs.readFileString(path.join(dir, "complete.txt"))).toBe("complete");
    }).pipe(Effect.scoped),
  30000,
);
