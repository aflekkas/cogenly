import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as PtyAdapter from "@cogenly/shared/PtyAdapter";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ReadOnlySandbox from "./ReadOnlySandbox.ts";
import * as Manager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

// Keep package fixtures independent of bubblewrap installed on the test host.
const isolatedFileSystem = (fs: FileSystem.FileSystem, directory: string) =>
  FileSystem.FileSystem.of({
    ...fs,
    stat: (path) =>
      fs.stat(
        path === "/usr/bin/bwrap" || path === "/bin/bwrap"
          ? `${directory}/missing-host-bwrap`
          : path,
      ),
  });

it.effect("Windows refuses chat terminals without attempting a launch", () =>
  Effect.gen(function* () {
    const sandbox = yield* ReadOnlySandbox.make;
    expect(sandbox.status.available).toBe(false);
    const error = yield* sandbox
      .prepare({ shell: "cmd.exe", args: [], cwd: "." })
      .pipe(Effect.flip);
    expect(error.message).toContain("supported only on macOS and Linux");
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () => Effect.die("Unsupported platforms must never spawn"),
      }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect("a failed startup probe never falls back to an unconstrained shell", () =>
  Effect.gen(function* () {
    let probes = 0;
    const sandbox = yield* ReadOnlySandbox.make.pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () => {
            probes++;
            return Effect.succeed({
              stdout: "",
              stderr: "sandbox unavailable",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      ),
    );
    expect(probes).toBe(1);
    expect(sandbox.status.available).toBe(false);
    const error = yield* sandbox
      .prepare({ shell: "/bin/sh", args: ["-c", "touch file"], cwd: "/" })
      .pipe(Effect.flip);
    expect(error.message).toContain("Chat commands are unavailable");
    expect(probes).toBe(1);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect.each(["missing bwrap", "user namespace probe denied"])(
  "Linux fails closed: %s",
  (failure) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-bwrap-test-" });
      if (failure !== "missing bwrap") {
        yield* fs.writeFileString(`${directory}/bwrap`, "");
        yield* fs.chmod(`${directory}/bwrap`, 0o755);
      }
      let probes = 0;
      const sandbox = yield* ReadOnlySandbox.make.pipe(
        Effect.provideService(HostProcess.Environment, { PATH: directory }),
        Effect.provideService(FileSystem.FileSystem, isolatedFileSystem(fs, directory)),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) => {
              probes++;
              expect(input.args).toContain("--unshare-user");
              return Effect.succeed({
                stdout: "",
                stderr: "",
                code: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
      );
      expect(probes).toBe(failure === "missing bwrap" ? 0 : 1);
      expect(sandbox.status.available).toBe(false);
      const error = yield* sandbox
        .prepare({ shell: "/bin/sh", args: [], cwd: "/" })
        .pipe(Effect.flip);
      expect(error.message).toContain(
        failure === "missing bwrap" ? "bubblewrap isn't installed" : "confinement probe failed",
      );
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
  "macOS behavioral sandbox (requires macOS sandbox-exec; skipped on other platforms)",
  () => {
    it.effect(
      "reads a project but denies writes, including descendants started through terminal input",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* ReadOnlySandbox.ReadOnlySandbox;
          expect(sandbox.status).toEqual({ available: true, backend: "sandbox-exec" });
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "cogenly-sandbox-project-",
          });
          const cwd = yield* fs.realPath(directory);
          yield* fs.writeFileString(`${cwd}/existing`, "project contents");
          const manager = yield* Manager.makeWithOptions({
            logsDir: `${cwd}/logs`,
            ptyAdapter: yield* PtyAdapter.PtyAdapter,
            processTable: Effect.succeed([]),
            processKillGraceMs: 0,
          });
          const started = yield* manager.runAgent({
            threadId: "chat-sandbox",
            cwd,
            terminalPolicy: "readOnlyLookup",
            background: true,
            command:
              'cat existing; ! (printf bad >existing); printf allowed >"$TMPDIR/scratch"; read command; /bin/sh -c "$command"',
          });
          yield* manager.write({
            threadId: "chat-sandbox",
            terminalId: started.terminalId,
            data: "printf bad >changed; cat existing\n",
          });
          const result = yield* manager.waitAgent({
            threadId: "chat-sandbox",
            terminalId: started.terminalId,
          });
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("project contents");
          expect(result.output).toMatch(/Operation not permitted|Permission denied/);
          expect(yield* fs.readFileString(`${cwd}/existing`)).toBe("project contents");
          expect(yield* fs.exists(`${cwd}/changed`)).toBe(false);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(ReadOnlySandbox.layer, ProcessRunner.layer, NodePtyAdapter.layer).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.scoped,
        ),
    );
  },
);

it.effect.each([
  "sudo",
  "root",
  "no-sudo",
  "install-fails",
  "probe-still-fails",
  "already-working",
] as const)("provisioning with %s keeps authorization tied to the latest probe", (mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-provision-test-" });
    const executable = (name: string) =>
      fs
        .writeFileString(`${directory}/${name}`, "")
        .pipe(Effect.andThen(fs.chmod(`${directory}/${name}`, 0o755)));
    yield* executable("apt-get");
    if (mode === "already-working") yield* executable("bwrap");
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          const sudoCheck = input.command === "sudo" && input.args.join(" ") === "-n true";
          const install = input.args.includes("install");
          if (install && mode !== "install-fails") yield* executable("bwrap").pipe(Effect.orDie);
          const denied =
            (sudoCheck && mode === "no-sudo") ||
            (install && mode === "install-fails") ||
            (input.command === "/bin/sh" && mode === "probe-still-fails");
          return {
            stdout: input.command === "/bin/sh" && !denied ? "readable" : "",
            stderr: denied ? "Operation not permitted" : "",
            code: denied ? null : ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const sandbox = yield* ReadOnlySandbox.make.pipe(
      Effect.provideService(HostProcess.Environment, { PATH: directory }),
      Effect.provideService(FileSystem.FileSystem, isolatedFileSystem(fs, directory)),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    if (mode !== "already-working") {
      expect(sandbox.status).toMatchObject({ available: false, failure: "bwrap-missing" });
      yield* sandbox.prepare({ shell: "/bin/sh", args: [], cwd: "/" }).pipe(Effect.flip);
    }
    const result = yield* sandbox.setup;
    const enabled = mode === "sudo" || mode === "root" || mode === "already-working";
    expect(result.available).toBe(enabled);
    expect(sandbox.status.available).toBe(enabled);
    if (enabled) {
      expect((yield* sandbox.prepare({ shell: "/bin/sh", args: [], cwd: "/" })).args).toContain(
        "--seccomp",
      );
      const installs = calls.filter((call) => call.args.includes("install")).length;
      yield* sandbox.setup;
      expect(calls.filter((call) => call.args.includes("install"))).toHaveLength(installs);
    } else {
      yield* sandbox.prepare({ shell: "/bin/sh", args: [], cwd: "/" }).pipe(Effect.flip);
      expect(result.command).toContain("apt-get install -y bubblewrap");
    }
    if (mode === "no-sudo")
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([["sudo", "-n", "true"]]);
    if (mode === "root" || mode === "already-working")
      expect(calls.some((call) => call.command === "sudo")).toBe(false);
    for (const call of calls.filter((call) => call.command === "sudo"))
      expect(call.args[0]).toBe("-n");
    if (mode === "install-fails") expect(result.message).toContain("installation failed");
    if (mode === "probe-still-fails")
      expect(result.message).toContain("host restriction still needs attention");
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.UserId, mode === "root" ? 0 : 1000),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect("an unsupported Linux architecture never starts a command or tries to install", () =>
  Effect.gen(function* () {
    const sandbox = yield* ReadOnlySandbox.make;
    expect(sandbox.status).toMatchObject({ available: false, failure: "architecture-unsupported" });
    expect((yield* sandbox.setup).available).toBe(false);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "s390x"),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => Effect.die("must not spawn") }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect.each([
  ["bwrap: Creating new namespace failed: Operation not permitted", "1", "apparmor-userns"],
  ["bwrap: Creating new namespace failed: Operation not permitted", "0", "userns-blocked"],
  ["bwrap: prctl(PR_SET_SECCOMP): Invalid argument", "1", "seccomp-unsupported"],
] as const)("the real probe classifies %s with AppArmor sysctl %s", ([stderr, sysctl, failure]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-probe-fixture-" });
    yield* fs.writeFileString(`${directory}/bwrap`, "");
    yield* fs.chmod(`${directory}/bwrap`, 0o755);
    const sandbox = yield* ReadOnlySandbox.make.pipe(
      Effect.provideService(HostProcess.Environment, { PATH: directory }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...isolatedFileSystem(fs, directory),
          readFileString: (path, options) =>
            path === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
              ? Effect.succeed(sysctl)
              : fs.readFileString(path, options),
        }),
      ),
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.succeed({
              stdout: "",
              stderr,
              code: ChildProcessSpawner.ExitCode(1),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
      ),
    );
    expect(sandbox.status).toMatchObject({ available: false, failure });
    yield* sandbox.prepare({ shell: "/bin/sh", args: [], cwd: "/" }).pipe(Effect.flip);
    if (failure === "seccomp-unsupported") expect((yield* sandbox.setup).command).toBeNull();
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect("install hooks are a no-op on macOS", () =>
  ReadOnlySandbox.provisionLocal.pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: () => Effect.die("must not spawn") }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("authorization stays off until a replacement probe finishes", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let probes = 0;
    const sandbox = yield* ReadOnlySandbox.make.pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.gen(function* () {
              if (++probes > 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(resume);
              }
              return {
                stdout: "readable",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      ),
    );
    expect(sandbox.status.available).toBe(true);
    const fixing = yield* Effect.forkChild(sandbox.setup);
    yield* Deferred.await(entered);
    expect(sandbox.status.available).toBe(false);
    yield* sandbox.prepare({ shell: "/bin/sh", args: [], cwd: "/" }).pipe(Effect.flip);
    yield* Deferred.succeed(resume, undefined);
    expect((yield* Fiber.join(fixing)).available).toBe(true);
    expect(sandbox.status.available).toBe(true);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
