import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import { parseServiceState } from "../cloud/serviceProtocol.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Path from "effect/Path";

import { FetchHttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };

import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { retireLegacyLauncher, runUpdate } from "./update.ts";

/** A home with two downloaded versions and an empty bin directory on PATH. */
const setup = (oldVersion = "0.1.0") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-update-launcher-" });
    const versionsDir = path.join(root, "home/runtime/versions");
    const oldEntry = path.join(versionsDir, oldVersion, "t3");
    const newEntry = path.join(versionsDir, "0.2.0/t3");
    const bin = path.join(root, "bin");
    for (const entry of [oldEntry, newEntry]) {
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(path.dirname(entry), ".install-complete"),
        `${path.basename(path.dirname(entry))}\n`,
      );
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
      const { fs, path, oldEntry, bin } = yield* setup(packageJson.version);
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(oldEntry, legacy);
      yield* runUpdate({
        baseDir: path.join(bin, "..", "home"),
        logsDir: path.join(bin, "..", "home", "logs"),
        serverRuntimeStatePath: path.join(bin, "..", "home", "runtime-state.json"),
        channel: undefined,
        requestedVersion: packageJson.version,
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

describe("runUpdate when already current but the target runtime is absent", () => {
  it.effect("fails without removing the only working t3 launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-update-missing-" });
      const home = path.join(root, "home");
      const olderEntry = path.join(home, "runtime/versions/0.0.9/t3");
      yield* fs.makeDirectory(path.dirname(olderEntry), { recursive: true });
      yield* fs.writeFileString(olderEntry, "");
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(olderEntry, legacy);
      const error = yield* Effect.flip(
        runUpdate({
          baseDir: home,
          logsDir: path.join(home, "logs"),
          serverRuntimeStatePath: path.join(home, "runtime-state.json"),
          channel: undefined,
          requestedVersion: packageJson.version,
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
        ),
      );
      expect(error).toMatchObject({ _tag: "PinnedRuntimeInstallError" });
      expect(yield* fs.readLink(legacy)).toBe(olderEntry);
      expect(yield* fs.exists(path.join(bin, "cogenly"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("retireLegacyLauncher", () => {
  it.effect("keeps t3 when the target runtime does not exist", () =>
    Effect.gen(function* () {
      const { fs, path, versionsDir, oldEntry, bin } = yield* setup();
      const legacy = path.join(bin, "t3");
      yield* fs.symlink(oldEntry, legacy);
      const replaced = yield* retire({
        launchedAs: legacy,
        versionsDir,
        targetEntryPath: path.join(versionsDir, "9.9.9/t3"),
      });
      expect(replaced).toEqual([]);
      expect(yield* fs.readLink(legacy)).toBe(oldEntry);
      expect(yield* fs.exists(path.join(bin, "cogenly"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces our t3 launcher with a cogenly one pointing at the new version", () =>
    Effect.gen(function* () {
      const { fs, path, versionsDir, oldEntry, newEntry, bin } = yield* setup();
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
      const { fs, path, root, versionsDir, newEntry, bin } = yield* setup();
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
      const { fs, path, versionsDir, oldEntry, newEntry, bin } = yield* setup();
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

describe("service update preflight", () => {
  it.effect.each(["blocked", "invalid", "exit"])(
    "refuses a %s preflight before changing the launcher or service",
    (failure) =>
      Effect.gen(function* () {
        const { fs, path, oldEntry, newEntry, bin } = yield* setup();
        const home = path.resolve(bin, "../home");
        const launcher = path.join(bin, "cogenly");
        yield* fs.symlink(oldEntry, launcher);
        let installed = false;
        const calls: string[] = [];
        const error = yield* runUpdate({
          baseDir: home,
          logsDir: path.join(home, "logs"),
          serverRuntimeStatePath: path.join(home, "runtime.json"),
          channel: undefined,
          requestedVersion: "0.2.0",
          allowDowngrade: true,
          assumeYes: true,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(BootService.BootService)({
                status: Effect.succeed({
                  supported: true,
                  installed: true,
                  current: false,
                  installedVersion: "0.1.0",
                  installedBaseDir: home,
                  unitPath: "unit",
                  logPath: "log",
                }),
                install: () =>
                  Effect.sync(() => {
                    installed = true;
                    throw new Error("must not install");
                  }),
              }),
              Layer.mock(ProcessRunner.ProcessRunner)({
                run: (input) => {
                  calls.push(input.args.join(" "));
                  const preflight = input.args.includes("__service-preflight");
                  return Effect.succeed({
                    code: ChildProcessSpawner.ExitCode(preflight && failure === "exit" ? 1 : 0),
                    stdout: preflight
                      ? failure === "invalid"
                        ? "invalid"
                        : JSON.stringify({
                            status: "blocked",
                            version: "0.2.0",
                            reason: "Migration blocked",
                          })
                      : "cogenly v0.2.0",
                    stderr: "",
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  });
                },
              }),
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "arm64"),
              Layer.succeed(HostProcess.IsExecutable, true),
              Layer.succeed(HostProcess.InvokedAs, launcher),
              Layer.succeed(HostProcess.WorkingDirectory, bin),
              Layer.succeed(HostProcess.UserId, 1000),
              Layer.succeed(HostProcess.Environment, { PATH: bin }),
              FetchHttpClient.layer,
            ),
          ),
          Effect.flip,
        );
        expect(error._tag).toBe("PinnedRuntimePreflightBlockedError");
        expect(installed).toBe(false);
        expect(calls.some((call) => call.includes("__service-preflight"))).toBe(true);
        expect(yield* fs.readLink(launcher)).toBe(oldEntry);
        expect(yield* fs.exists(newEntry)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it.effect.each([false, true])(
  "non-interactive update stages the release and restarts only with --yes (%s)",
  (assumeYes) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const console = yield* Console.Console;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-update-nontty-" });
      const baseDir = path.join(root, "owner's home");
      const version = packageJson.version;
      const runtime = path.join(baseDir, "runtime/versions", version);
      const unit = path.join(root, ".config/systemd/user/cogenly.service");
      const stateFile = path.join(baseDir, "runtime/service-state.json");
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.writeFileString(path.join(runtime, "cogenly"), "");
      yield* fs.writeFileString(path.join(runtime, ".install-complete"), version);
      yield* fs.makeDirectory(path.dirname(unit), { recursive: true });
      yield* fs.writeFileString(unit, "old unit");
      yield* fs.writeFileString(stateFile, JSON.stringify({ protocol: 3, activeVersion: "0.0.1" }));
      const commands: string[] = [];
      const output: unknown[] = [];
      yield* runUpdate({
        baseDir,
        logsDir: path.join(root, "logs"),
        serverRuntimeStatePath: path.join(root, "runtime-state.json"),
        channel: undefined,
        requestedVersion: version,
        allowDowngrade: false,
        assumeYes,
        interactive: false,
      }).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          log: (...values) => {
            output.push(...values);
          },
        }),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ HOME: root, PATH: "" }),
            ),
            Layer.mock(BootService.BootService)({
              status: Effect.succeed({
                supported: true,
                installed: true,
                current: false,
                installedVersion: "0.0.1",
                installedBaseDir: baseDir,
                unitPath: unit,
                logPath: path.join(root, "logs/boot-service.log"),
              }),
            }),
            Layer.succeed(HostProcess.Platform, "linux" as const),
            Layer.succeed(HostProcess.Architecture, "arm64" as const),
            Layer.succeed(HostProcess.IsExecutable, true),
            Layer.succeed(HostProcess.Environment, {
              HOME: root,
              PATH: "",
              COGENLY_RELEASE_BASE_URL: "https://example.invalid/releases",
            }),
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: (input) => {
                commands.push(`${input.command} ${input.args.join(" ")}`);
                return Effect.succeed({
                  code: ChildProcessSpawner.ExitCode(0),
                  stdout: input.args.includes("--version")
                    ? `cogenly v${version}`
                    : input.args.includes("__service-preflight")
                      ? JSON.stringify({ status: "ready", version, launcherProtocol: 3 })
                      : input.command === "loginctl"
                        ? "yes"
                        : "",
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                });
              },
            }),
            FetchHttpClient.layer,
          ),
        ),
      );
      expect(commands.some((command) => command === "systemctl --user stop cogenly.service")).toBe(
        assumeYes,
      );
      expect(
        commands.some((command) => command === "systemctl --user restart cogenly.service"),
      ).toBe(assumeYes);
      expect(yield* fs.exists(path.join(baseDir, "runtime/.restart-pending"))).toBe(!assumeYes);
      expect(parseServiceState(yield* fs.readFileString(stateFile))).toMatchObject({
        activeVersion: "0.0.1",
        update: { targetVersion: version, status: "pending" },
      });
      if (!assumeYes) {
        const command = `cogenly service restart --base-dir '${baseDir.replaceAll("'", "'\\''")}'`;
        expect(output.join("\n")).toContain(`To activate this update afterwards, run: ${command}`);
        expect(output.join("\n")).toContain("Background service still running 0.0.1");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
