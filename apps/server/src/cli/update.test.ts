import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { FetchHttpClient } from "effect/http";

import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { retireLegacyLauncher, runUpdate } from "./update.ts";

/** A home with two downloaded versions and an empty bin directory on PATH. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-update-launcher-" });
  const versionsDir = path.join(root, "home/runtime/versions");
  const oldEntry = path.join(versionsDir, "0.1.0/t3");
  const newEntry = path.join(versionsDir, "0.2.0/t3");
  const bin = path.join(root, "bin");
  for (const entry of [oldEntry, newEntry]) {
    yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
    yield* fs.writeFileString(entry, "");
  }
  yield* fs.makeDirectory(bin, { recursive: true });
  return { fs, path, root, versionsDir, oldEntry, newEntry, bin };
});

const retire = (input: { launchedAs: string; versionsDir: string; targetEntryPath: string }) =>
  retireLegacyLauncher(input).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, { PATH: "" }),
  );

describe("runUpdate when already current", () => {
  it.effect("still replaces a legacy t3 launcher with cogenly", () =>
    Effect.gen(function* () {
      const { fs, path, oldEntry, bin } = yield* setup;
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(oldEntry, legacy);
      yield* runUpdate({
        baseDir: path.join(bin, "..", "home"),
        logsDir: path.join(bin, "..", "home", "logs"),
        serverRuntimeStatePath: path.join(bin, "..", "home", "runtime-state.json"),
        channel: undefined,
        requestedVersion: "0.1.0",
        allowDowngrade: false,
        assumeYes: true,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(BootService.BootService)({
              status: Effect.succeed({
                supported: false,
                installed: false,
                current: false,
                unitPath: "",
                logPath: "",
              }),
            }),
            Layer.succeed(HostProcess.Platform, "linux" as const),
            Layer.succeed(HostProcess.Architecture, "arm64" as const),
            Layer.succeed(HostProcess.IsExecutable, true),
            Layer.succeed(HostProcess.InvokedAs, legacy),
            Layer.succeed(HostProcess.WorkingDirectory, bin),
            Layer.succeed(HostProcess.Environment, {
              PATH: bin,
              COGENLY_RELEASE_BASE_URL: "https://example.invalid/releases",
            }),
            ProcessRunner.layer,
            FetchHttpClient.layer,
          ),
        ),
      );
      expect(yield* fs.exists(legacy)).toBe(false);
      expect(yield* fs.readLink(path.join(bin, "cogenly"))).toBe(oldEntry);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("retireLegacyLauncher", () => {
  it.effect("replaces our t3 launcher with a cogenly one pointing at the new version", () =>
    Effect.gen(function* () {
      const { fs, path, versionsDir, oldEntry, newEntry, bin } = yield* setup;
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(oldEntry, legacy);

      const replaced = yield* retire({
        launchedAs: legacy,
        versionsDir,
        targetEntryPath: newEntry,
      });

      expect(replaced).toEqual([path.join(bin, "cogenly")]);
      expect(yield* fs.readLink(path.join(bin, "cogenly"))).toBe(newEntry);
      expect(yield* fs.exists(legacy)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a t3 that is not a launcher into this home", () =>
    Effect.gen(function* () {
      const { fs, path, root, versionsDir, newEntry, bin } = yield* setup;
      const foreign = path.join(root, "elsewhere/t3");
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.writeFileString(foreign, "");
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(foreign, legacy);

      const replaced = yield* retire({
        launchedAs: path.join(bin, "cogenly"),
        versionsDir,
        targetEntryPath: newEntry,
      });

      expect(replaced).toEqual([]);
      expect(yield* fs.readLink(legacy)).toBe(foreign);
      expect(yield* fs.exists(path.join(bin, "cogenly"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps our t3 when a cogenly beside it belongs to something else", () =>
    Effect.gen(function* () {
      const { fs, path, versionsDir, oldEntry, newEntry, bin } = yield* setup;
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(oldEntry, legacy);
      yield* fs.writeFileString(path.join(bin, "cogenly"), "#!/bin/sh\n");

      const replaced = yield* retire({
        launchedAs: legacy,
        versionsDir,
        targetEntryPath: newEntry,
      });

      expect(replaced).toEqual([]);
      expect(yield* fs.readLink(legacy)).toBe(oldEntry);
      expect(yield* fs.readFileString(path.join(bin, "cogenly"))).toBe("#!/bin/sh\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
