import type { ChatSandboxSetupResult } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { resolveCommandPath } from "@cogenly/shared/shell";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  apparmorBwrapProfile,
  apparmorBwrapProfilePath,
  apparmorProfileInstallCommand,
  apparmorProfileInstallCommands,
  apparmorUsernsSysctlPath,
  classifyLinuxSandboxFailure,
  detectSandboxPackageManager,
  isAppArmorUsernsRestricted,
  sandboxFailureReason,
  sandboxInstallCommand,
  sandboxInstallCommands,
  type SandboxFailure,
} from "./sandboxProvisioning.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  linuxReadOnlyArguments,
  linuxReadOnlySeccomp,
  linuxSandboxPrelude,
  macReadOnlyProfile,
} from "./readOnlyLookup.ts";

export type SandboxStatus =
  | { readonly available: true; readonly backend: "sandbox-exec" | "bwrap" }
  | { readonly available: false; readonly reason: string; readonly failure?: SandboxFailure };

export interface SandboxLaunch {
  readonly shell: string;
  readonly args: string[];
  readonly env: Readonly<Record<string, string>>;
}

export class SandboxUnavailable extends Schema.TaggedError<SandboxUnavailable>()(
  "SandboxUnavailable",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return `Chat commands are unavailable on this machine: ${this.reason}`;
  }
}

export class ReadOnlySandbox extends Context.Service<
  ReadOnlySandbox,
  {
    readonly status: SandboxStatus;
    readonly setup: Effect.Effect<ChatSandboxSetupResult>;
    readonly prepare: (input: {
      readonly shell: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
    }) => Effect.Effect<SandboxLaunch, SandboxUnavailable>;
  }
>()("cogenly-server/terminal/ReadOnlySandbox") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const resolve = (command: string) =>
    resolveCommandPath(command, { env: environment }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const scope = yield* Effect.scope;
  const filter = platform === "linux" ? linuxReadOnlySeccomp(architecture) : null;
  let binary: string | null = null;
  let status: SandboxStatus = {
    available: false,
    failure: "probe-failed",
    reason: sandboxFailureReason("probe-failed"),
  };
  const unavailable = (failure: SandboxFailure): SandboxStatus => ({
    available: false,
    failure,
    reason: sandboxFailureReason(failure),
  });
  /** Fresh read after a reprobe, without the caller's narrowed view of `status`. */
  const currentFailure = (): SandboxFailure | undefined =>
    status.available ? undefined : status.failure;
  const prepare = Effect.fn("ReadOnlySandbox.prepare")(function* (input: {
    readonly shell: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) {
    const sandboxBinary = binary;
    if (sandboxBinary === null)
      return yield* new SandboxUnavailable({
        reason: status.available ? "sandbox binary unavailable" : status.reason,
      });
    // Owned by the service scope, never reused by a later terminal. Keep the
    // directory until server shutdown: descendants can outlive their shell.
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-lookup-" }).pipe(
      Scope.provide(scope),
      Effect.flatMap((dir) => fs.realPath(dir)),
      Effect.mapError(
        () =>
          new SandboxUnavailable({ reason: "a private sandbox directory could not be created." }),
      ),
    );
    if (platform === "darwin") {
      return {
        shell: sandboxBinary,
        args: ["-p", macReadOnlyProfile(directory), input.shell, ...input.args],
        env: { TMPDIR: directory, TMP: directory, TEMP: directory },
      };
    }
    const filterPath = `${directory}/seccomp.bpf`;
    yield* fs
      .writeFile(filterPath, filter!)
      .pipe(
        Effect.mapError(
          () => new SandboxUnavailable({ reason: "the sandbox filter could not be prepared." }),
        ),
      );
    return {
      shell: "/bin/sh",
      args: [
        "-c",
        linuxSandboxPrelude,
        "cogenly-sandbox",
        filterPath,
        sandboxBinary,
        ...linuxReadOnlyArguments(input),
      ],
      env: { TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" },
    };
  });
  // Exercise the actual launch and confinement before advertising commands.
  // Resolve the binary again on each probe so a package installed at runtime is usable.
  const reprobe = Effect.gen(function* () {
    if (platform !== "darwin" && platform !== "linux") return unavailable("platform-unsupported");
    if (platform === "linux" && filter === null) return unavailable("architecture-unsupported");
    binary = platform === "darwin" ? "/usr/bin/sandbox-exec" : null;
    if (platform === "linux") {
      // Absolute lookups bypass the command cache's negative entry after installation.
      for (const directory of new Set([
        "/usr/bin",
        "/bin",
        ...(environment.PATH ?? "").split(":"),
      ])) {
        if (!directory.startsWith("/")) continue;
        binary = yield* resolve(`${directory}/bwrap`);
        if (binary !== null) break;
      }
    }
    if (binary === null) return unavailable("bwrap-missing");
    return yield* Effect.gen(function* () {
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-lookup-probe-" });
      const protectedFile = `${yield* fs.realPath(project)}/existing`;
      yield* fs.writeFileString(protectedFile, "readable");
      const launch = yield* prepare({
        shell: "/bin/sh",
        args: [
          "-c",
          'cat "$1" && printf probe >"$TMPDIR/probe" && ! (printf denied >"$1")',
          "probe",
          protectedFile,
        ],
        cwd: yield* fs.realPath(project),
      });
      const result = yield* runner.run({
        command: launch.shell,
        args: launch.args,
        cwd: "/",
        env: { ...environment, ...launch.env },
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      });
      if (
        result.code === 0 &&
        result.stdout.includes("readable") &&
        (yield* fs.readFileString(protectedFile)) === "readable"
      )
        return {
          available: true,
          backend: platform === "darwin" ? "sandbox-exec" : "bwrap",
        } as const;
      const appArmorRestricted =
        platform === "linux" &&
        isAppArmorUsernsRestricted(
          yield* fs.readFileString(apparmorUsernsSysctlPath).pipe(Effect.orElseSucceed(() => "0")),
        );
      return unavailable(
        platform === "linux"
          ? classifyLinuxSandboxFailure(result.stderr, appArmorRestricted)
          : "sandbox-exec-failed",
      );
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() =>
        unavailable(platform === "darwin" ? "sandbox-exec-failed" : "probe-failed"),
      ),
    );
  });
  const refresh = Effect.gen(function* () {
    // Keep launches off while resolving and testing a possibly changed binary.
    status = unavailable(platform === "darwin" ? "sandbox-exec-failed" : "probe-failed");
    status = yield* reprobe;
  });
  yield* refresh;
  yield* Effect.logInfo("Chat terminal sandbox probe", status);
  const semaphore = yield* Semaphore.make(1);
  const setup = Effect.gen(function* () {
    yield* refresh;
    const result = (message: string, command: string | null = null): ChatSandboxSetupResult => ({
      available: status.available,
      message,
      command,
    });
    if (status.available) return result("Chat commands are on: the sandbox probe passed.");
    if (
      platform !== "linux" ||
      status.failure === "architecture-unsupported" ||
      status.failure === "seccomp-unsupported"
    )
      return result(`Chat commands are off: ${status.reason}.`);
    const root = (yield* HostProcess.UserId) === 0;
    const run = (command: string, args: string[], timeout: "5 seconds" | "5 minutes", stdin = "") =>
      runner
        .run({
          command,
          args,
          timeout,
          maxOutputBytes: 4096,
          stdin,
          outputMode: "truncate",
          env: { ...environment, DEBIAN_FRONTEND: "noninteractive", SUDO_ASKPASS: "/bin/false" },
        })
        .pipe(
          Effect.map((r) => r.code === 0 && !r.timedOut),
          Effect.orElseSucceed(() => false),
        );
    const runPrivileged = (executable: string, args: string[], stdin = "") =>
      run(
        root ? executable : "sudo",
        root ? args : ["-n", "--", executable, ...args],
        "5 minutes",
        stdin,
      );
    // bubblewrap present but blocked by AppArmor needs no package install.
    if (status.failure !== "apparmor-userns") {
      const available: string[] = [];
      for (const manager of ["apt-get", "dnf", "pacman", "zypper", "apk"])
        if (yield* resolve(manager)) available.push(manager);
      const manager = detectSandboxPackageManager(available);
      if (manager === null)
        return result(
          "Chat commands are off: no supported package manager was found. Install the distro bubblewrap package, then run cogenly security setup.",
        );
      const command = sandboxInstallCommand(manager, root);
      if (!root && !(yield* run("sudo", ["-n", "true"], "5 seconds")))
        return result(`Chat commands are off: ${status.reason}. Run: ${command}`, command);
      for (const [executable, ...args] of sandboxInstallCommands(manager)) {
        if (!(yield* runPrivileged(executable!, args)))
          return result(`Chat sandbox installation failed. Run: ${command}`, command);
      }
      yield* refresh;
      if (status.available)
        return result(
          "Chat commands are on: bubblewrap is installed and the sandbox probe passed.",
        );
      if (currentFailure() !== "apparmor-userns")
        return result(
          `Chat commands are off: ${status.reason}. The distro package was installed; the host restriction still needs attention.`,
          command,
        );
    }
    // AppArmor userns restriction: install only the per-bwrap profile, and
    // never touch the global sysctl. An existing profile is left alone.
    const bwrapPath = binary ?? "/usr/bin/bwrap";
    const profileCommand = apparmorProfileInstallCommand(bwrapPath, root);
    const profileExists = yield* fs
      .exists(apparmorBwrapProfilePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (profileExists)
      return result(
        `Chat commands are off: ${status.reason}. The AppArmor profile at ${apparmorBwrapProfilePath} already exists, so it was left unchanged; the global AppArmor user-namespace restriction stays on.`,
      );
    if (!root && !(yield* run("sudo", ["-n", "true"], "5 seconds")))
      return result(
        `Chat commands are off: ${status.reason}. Run:\n${profileCommand}`,
        profileCommand,
      );
    const profile = apparmorBwrapProfile(bwrapPath);
    for (const [executable, ...args] of apparmorProfileInstallCommands()) {
      if (!(yield* runPrivileged(executable, args, executable === "tee" ? profile : "")))
        return result(
          `Chat sandbox AppArmor setup failed. Run:\n${profileCommand}`,
          profileCommand,
        );
    }
    yield* refresh;
    return status.available
      ? result(
          "Chat commands are on: the AppArmor profile for bubblewrap is installed and the sandbox probe passed. The global AppArmor user-namespace restriction stays on.",
        )
      : result(
          `Chat commands are off: ${status.reason}. The AppArmor profile was installed; the host restriction still needs attention.`,
          profileCommand,
        );
  }).pipe(semaphore.withPermit);
  return ReadOnlySandbox.of({
    get status() {
      return status;
    },
    setup,
    prepare: (input) =>
      Effect.suspend(() =>
        status.available
          ? prepare(input)
          : Effect.fail(new SandboxUnavailable({ reason: status.reason })),
      ),
  });
});

export const layer = Layer.effect(ReadOnlySandbox, make).pipe(Layer.provide(ProcessRunner.layer));

/** Install/update entry points share the runtime's provisioning and confinement probe. */
export const provisionLocal = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return;
  const result = yield* make.pipe(
    Effect.flatMap((sandbox) => sandbox.setup),
    Effect.scoped,
  );
  if (!result.available) yield* Console.log(result.message);
});
