// @effect-diagnostics nodeBuiltinImport:off - the Windows launch smoke tests use filesystem notifications to observe real PowerShell launches.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ExternalLauncher from "./externalLauncher.ts";

// Tests below write `#!/bin/sh` stubs into a real temp dir and hand that
// directory to a posix-mocked resolver as PATH. On a Windows host the temp
// path carries a drive letter, so the posix `:` split shatters it; there is
// no posix executable to find there anyway.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

interface MockSpawnResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  /** Never deliver an exit code, like a child wedged on a broken desktop session. */
  readonly stall?: boolean;
}

function makeMockDetachedHandle(input: MockSpawnResult & { readonly onUnref?: () => void } = {}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.stall
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      input.onUnref?.();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerTest = (input: {
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly resolveExecutable?: (command: string) => string | undefined;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onUnref?: () => void;
  readonly spawnResult?: (command: ChildProcess.StandardCommand) => MockSpawnResult | undefined;
}) => {
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        input.onSpawn?.(command);
        return makeMockDetachedHandle({
          ...(input.onUnref === undefined ? {} : { onUnref: input.onUnref }),
          ...input.spawnResult?.(command),
        });
      }),
    ),
  );

  return Layer.mergeAll(
    ExternalLauncher.layer.pipe(Layer.provide(Layer.merge(NodeServices.layer, layerSpawner))),
    Layer.succeed(HostProcess.Platform, input.platform),
    Layer.succeed(
      SpawnExecutableResolution,
      (command) => input.resolveExecutable?.(command) ?? command,
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
  );
};

it.effect("launches the default browser through the platform command", () => {
  let spawned: ChildProcess.StandardCommand | undefined;
  let didUnref = false;
  return Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    yield* launcher.launchBrowser("https://example.com/some path");

    assert.ok(spawned);
    assert.equal(spawned.command, "xdg-open");
    assert.deepEqual(spawned.args, ["https://example.com/some path"]);
    assert.equal(spawned.options.detached, true);
    assert.equal(didUnref, true);
  }).pipe(
    Effect.provide(
      layerTest({
        platform: "linux",
        onSpawn: (command) => {
          spawned = command;
        },
        onUnref: () => {
          didUnref = true;
        },
      }),
    ),
  );
});

it.effect.each(["win32", "linux"] as const)(
  "launches the browser through PowerShell on %s",
  (platform) => {
    let spawned: ChildProcess.StandardCommand | undefined;
    return Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;

      yield* launcher.launchBrowser("https://example.com/some path");

      assert.ok(spawned);
      assert.equal(
        spawned.command,
        platform === "win32"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      assert.deepEqual(spawned.args.slice(0, -1), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
      ]);
      const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
      const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
      assert.equal(
        decodedCommand,
        "$ProgressPreference = 'SilentlyContinue'; Start 'https://example.com/some path'",
      );
      assert.equal(spawned.options.detached, platform !== "win32");
    }).pipe(
      Effect.provide(
        layerTest({
          platform,
          env: { SYSTEMROOT: "C:\\Windows", WSL_DISTRO_NAME: "Ubuntu" },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );
  },
);

for (const platform of ["darwin", "linux"] as const) {
}

it.effect.skipIf(windowsHost)("reveals a file in Finder with open -R on macOS", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-manager-" });
    const openPath = path.join(binDir, "open");
    yield* fileSystem.writeFileString(openPath, "#!/bin/sh\n");
    yield* fileSystem.chmod(openPath, 0o755);

    let spawned: ChildProcess.StandardCommand | undefined;
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.revealInFileManager("/workspace/media/linux-mini-v2.mp4");
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.ok(spawned);
    assert.equal(spawned.command, "open");
    assert.deepEqual(spawned.args, ["-R", "/workspace/media/linux-mini-v2.mp4"]);
    assert.equal(spawned.options.detached, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reveals a file in File Explorer through PowerShell on Windows", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-manager-" });
    yield* fileSystem.writeFileString(path.join(binDir, "explorer.CMD"), "@echo off\r\n");
    // resolvePowerShellPath builds `${SYSTEMROOT}\System32\...` with Windows
    // separators, which on the posix test filesystem is one file name.
    const systemRoot = path.join(binDir, "system-root");
    const powerShellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    yield* fileSystem.makeDirectory(path.dirname(powerShellPath), { recursive: true });
    yield* fileSystem.writeFileString(powerShellPath, "");

    let spawned: ChildProcess.StandardCommand | undefined;
    const kind = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.revealInFileManager("C:/workspace with spaces/media/author's clip.mp4");
      return yield* launcher.resolveFileManagerRevealKind();
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "win32",
          env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD", SYSTEMROOT: systemRoot },
          onSpawn: (command) => {
            spawned = command;
          },
        }),
      ),
    );

    assert.equal(kind, "file-explorer");
    assert.ok(spawned);
    assert.equal(spawned.command, powerShellPath);
    assert.deepEqual(spawned.args.slice(0, -1), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const encodedCommand = spawned.args[spawned.args.length - 1] ?? "";
    const decodedCommand = Buffer.from(encodedCommand, "base64").toString("utf16le");
    // explorer.exe expects `/select,"<path>"` with only the path quoted;
    // PowerShell 5.1's Start-Process passes the argument string verbatim.
    assert.equal(
      decodedCommand,
      "$ProgressPreference = 'SilentlyContinue'; Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + 'C:\\workspace with spaces\\media\\author''s clip.mp4' + '\"')",
    );
    assert.equal(spawned.options.shell, false);
    assert.equal(spawned.options.detached, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Exercise real spawning, ignored stdio, unref, and scope cleanup. Only the
// destination application is replaced, so tests never open Explorer or a browser.
for (const kind of ["browser", "reveal"] as const) {
  it.live.skipIf(!windowsHost)(
    `completes a ${kind} launch through real PowerShell after the launcher scope closes`,
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-reveal-smoke-"));
        const outputPath = NodePath.join(tempDir, "argv.txt");
        const watcher = NodeFS.watch(tempDir, { signal: AbortSignal.timeout(20_000) });
        try {
          const recorderPath = NodePath.join(tempDir, "recorder.cmd");
          const stagingPath = NodePath.join(tempDir, "argv.tmp");
          NodeFS.writeFileSync(
            recorderPath,
            `@echo off\r\n>"${stagingPath}" echo(%*\r\nmove /y "${stagingPath}" "${outputPath}" >nul\r\n`,
          );
          // The rename publishes a complete result; no sleeps or file polling.
          const recorded = new Promise<string>((resolve, reject) => {
            watcher.on("change", () => {
              if (NodeFS.existsSync(outputPath)) {
                resolve(NodeFS.readFileSync(outputPath, "utf8").trim());
              }
            });
            watcher.on("error", reject);
            watcher.on("close", () =>
              reject(new Error("PowerShell did not run the recording stub")),
            );
          });

          const target = "C:/workspace with spaces/media/author's clip.mp4";
          yield* Effect.all(
            [
              Effect.gen(function* () {
                const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const recordingSpawner = ChildProcessSpawner.make((command) => {
                  assert.ok(ChildProcess.isStandardCommand(command));
                  const source = Buffer.from(command.args.at(-1) ?? "", "base64")
                    .toString("utf16le")
                    .replace("'explorer.exe'", `'${recorderPath.replaceAll("'", "''")}'`);
                  return realSpawner.spawn(
                    ChildProcess.make(
                      command.command,
                      [
                        ...command.args.slice(0, -1),
                        Buffer.from(source, "utf16le").toString("base64"),
                      ],
                      command.options,
                    ),
                  );
                });
                const launcher = yield* ExternalLauncher.make.pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
                );
                if (kind === "browser") {
                  yield* launcher.launchBrowser(recorderPath);
                } else {
                  yield* launcher.revealInFileManager(target);
                }
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
              Effect.promise(() =>
                recorded.then((value) => {
                  assert.equal(
                    value,
                    kind === "browser" ? "" : `/select,"${target.replaceAll("/", "\\")}"`,
                  );
                }),
              ),
            ],
            { concurrency: "unbounded" },
          );
        } finally {
          watcher.close();
          // The recording stub's cmd.exe can still hold the directory for a
          // moment after it publishes its output, which Windows reports as EPERM.
          NodeFS.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      }),
    { timeout: 30_000 },
  );
}

// When interop PowerShell is missing the capability advertises the Linux
// "files" kind (or nothing), so the reveal must open the Linux file manager
// the label promised even though plain open still prefers File Explorer.
it.effect.skipIf(windowsHost)(
  "reveals through the Linux file manager when WSL lacks interop PowerShell",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-manager-" });
      for (const name of ["explorer.exe", "xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const spawnedCommands: ChildProcess.StandardCommand[] = [];
      const kind = yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        const revealKind = yield* launcher.resolveFileManagerRevealKind();
        yield* launcher.revealInFileManager("/home/t3/workspace/media/clip.mp4");
        return revealKind;
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
              DISPLAY: ":0",
            },
            onSpawn: (command) => {
              spawnedCommands.push(command);
            },
            spawnResult: (command) =>
              command.command === "xdg-mime"
                ? { stdout: "org.gnome.Nautilus.desktop\n" }
                : undefined,
          }),
        ),
      );

      assert.equal(kind, "files");
      const launch = spawnedCommands.find((command) => command.command === "xdg-open");
      assert.ok(launch);
      assert.deepEqual(launch.args, ["/home/t3/workspace/media"]);
      assert.isUndefined(spawnedCommands.find((command) => command.command === "explorer.exe"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "falls back to opening the containing directory for WSL paths Explorer cannot select",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-manager-" });
      for (const name of ["explorer.exe", "powershell.exe"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      let spawned: ChildProcess.StandardCommand | undefined;
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.revealInFileManager('/home/t3/work "quoted"/clip.mp4');
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: {
              PATH: binDir,
              WSL_DISTRO_NAME: "Ubuntu-24.04",
              WSL_INTEROP: "/run/WSL/1_interop",
            },
            onSpawn: (command) => {
              spawned = command;
            },
          }),
        ),
      );

      // Explorer's raw switch cannot express a double quote, so the launch
      // opens the parent directory instead of misparsing a /select argument.
      assert.ok(spawned);
      assert.equal(spawned.command, "explorer.exe");
      assert.deepEqual(spawned.args, ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\t3\\work "quoted"']);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)("reveals by opening the containing directory on Linux", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-manager-" });
    for (const name of ["xdg-open", "xdg-mime"]) {
      const filePath = path.join(binDir, name);
      yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(filePath, 0o755);
    }

    const spawnedCommands: ChildProcess.StandardCommand[] = [];
    yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      yield* launcher.revealInFileManager("/workspace/media/linux-mini-v2.mp4");
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "linux",
          env: { PATH: binDir, DISPLAY: ":0" },
          onSpawn: (command) => {
            spawnedCommands.push(command);
          },
          spawnResult: (command) =>
            command.command === "xdg-mime" ? { stdout: "org.gnome.Nautilus.desktop\n" } : undefined,
        }),
      ),
    );

    const spawned = spawnedCommands.find((command) => command.command === "xdg-open");
    assert.ok(spawned);
    assert.deepEqual(spawned.args, ["/workspace/media"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
