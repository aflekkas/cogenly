import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ProcessRunner from "../processRunner.ts";
import {
  linuxReadOnlyArguments,
  linuxReadOnlySeccomp,
  linuxSandboxPrelude,
  macReadOnlyProfile,
} from "./readOnlyLookup.ts";

export type SandboxStatus =
  | { readonly available: true; readonly backend: "sandbox-exec" | "bwrap" }
  | { readonly available: false; readonly reason: string };

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
    readonly prepare: (input: {
      readonly shell: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
    }) => Effect.Effect<SandboxLaunch, SandboxUnavailable>;
  }
>()("cogenly-server/terminal/ReadOnlySandbox") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const scope = yield* Effect.scope;
  const filter = platform === "linux" ? linuxReadOnlySeccomp(architecture) : null;
  const binary =
    platform === "darwin"
      ? "/usr/bin/sandbox-exec"
      : platform === "linux" && filter !== null
        ? yield* resolveCommandPath("bwrap", { env: environment })
        : null;
  const unavailableReason =
    platform === "linux"
      ? filter === null
        ? "the read-only sandbox does not support this Linux architecture."
        : "bubblewrap and working user namespaces are required."
      : platform === "darwin"
        ? "sandbox-exec failed its read-only sandbox probe."
        : "read-only chat terminals are supported only on macOS and Linux.";
  const prepare = Effect.fn("ReadOnlySandbox.prepare")(function* (input: {
    readonly shell: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) {
    if (binary === null) return yield* new SandboxUnavailable({ reason: unavailableReason });
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
        shell: binary,
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
        binary,
        ...linuxReadOnlyArguments(input),
      ],
      env: { TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" },
    };
  });
  // Exercise the actual launch and confinement before advertising commands.
  const probe =
    binary === null
      ? false
      : yield* Effect.gen(function* () {
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
          return (
            result.code === 0 &&
            result.stdout.includes("readable") &&
            (yield* fs.readFileString(protectedFile)) === "readable"
          );
        }).pipe(
          Effect.scoped,
          Effect.orElseSucceed(() => false),
        );
  const status: SandboxStatus = probe
    ? { available: true, backend: platform === "darwin" ? "sandbox-exec" : "bwrap" }
    : { available: false, reason: unavailableReason };
  yield* Effect.logInfo("Chat terminal sandbox probe", status);
  return ReadOnlySandbox.of({
    status,
    prepare: status.available
      ? prepare
      : () => Effect.fail(new SandboxUnavailable({ reason: status.reason })),
  });
});

export const layer = Layer.effect(ReadOnlySandbox, make).pipe(Layer.provide(ProcessRunner.layer));
