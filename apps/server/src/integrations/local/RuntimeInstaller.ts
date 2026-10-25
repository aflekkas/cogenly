import type { IntegrationInstallRuntimeResult, IntegrationRuntime } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Where Homebrew lives on Apple silicon, Intel Macs and Linux. */
const BREW_PATHS = [
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew",
  "/home/linuxbrew/.linuxbrew/bin/brew",
];
const ASTRAL_SH = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const ASTRAL_PS = "irm https://astral.sh/uv/install.ps1 | iex";
const MAX_OUTPUT_CHARS = 1_000;

/**
 * Directories uv's installers put `uvx` in. A server started outside a login
 * shell may not have them on PATH, so managed processes search them too, and
 * an install takes effect without a restart.
 */
export const runtimeSearchDirectories = (platform: NodeJS.Platform, home: string) =>
  platform === "win32"
    ? [`${home}\\.local\\bin`]
    : [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];

/** How Cogenly would install a runtime here; `command` is also what a person runs by hand. */
export interface RuntimeInstallPlan {
  readonly canInstall: boolean;
  readonly command: string;
  readonly program: string;
  readonly args: ReadonlyArray<string>;
}

/** The installer process could not start or did not finish in time. */
export class InstallerSpawnError extends Schema.TaggedError<InstallerSpawnError>()(
  "InstallerSpawnError",
  { cause: Schema.Defect() },
) {}

/** The process boundary, injected so tests never run an installer. */
export interface InstallCommandRunner {
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly run: (
    program: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly exitCode: number; readonly output: string }, InstallerSpawnError>;
}

export class RuntimeInstaller extends Context.Service<
  RuntimeInstaller,
  {
    readonly plan: (runtime: IntegrationRuntime) => Effect.Effect<RuntimeInstallPlan>;
    /** Runs the plan's fixed command; never anything a caller supplied. One install at a time. */
    readonly install: (
      runtime: IntegrationRuntime,
    ) => Effect.Effect<IntegrationInstallRuntimeResult>;
  }
>()("cogenly-server/integrations/local/RuntimeInstaller") {}

export const make = (input: {
  readonly platform: NodeJS.Platform;
  readonly runner: InstallCommandRunner;
}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const plan = (_runtime: IntegrationRuntime) =>
      Effect.gen(function* () {
        if (input.platform === "win32")
          return {
            canInstall: true,
            command: `powershell -ExecutionPolicy ByPass -c "${ASTRAL_PS}"`,
            program: "powershell",
            args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-c", ASTRAL_PS],
          } satisfies RuntimeInstallPlan;
        if (input.platform !== "darwin" && input.platform !== "linux")
          return {
            canInstall: false,
            command: "See https://docs.astral.sh/uv/getting-started/installation/",
            program: "",
            args: [],
          } satisfies RuntimeInstallPlan;
        for (const brew of BREW_PATHS)
          if (yield* input.runner.exists(brew))
            return {
              canInstall: true,
              command: "brew install uv",
              program: brew,
              args: ["install", "uv"],
            } satisfies RuntimeInstallPlan;
        return {
          canInstall: true,
          command: ASTRAL_SH,
          program: "/bin/sh",
          args: ["-c", ASTRAL_SH],
        } satisfies RuntimeInstallPlan;
      });
    return RuntimeInstaller.of({
      plan,
      install: (runtime) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const chosen = yield* plan(runtime);
            if (!chosen.canInstall)
              return {
                installed: false,
                message: `Cogenly can't install uv on this system. ${chosen.command}`,
              };
            const result = yield* input.runner.run(chosen.program, chosen.args).pipe(Effect.result);
            if (result._tag === "Failure")
              return {
                installed: false,
                message: `The installer could not start. Run ${chosen.command} on this machine instead.`,
              };
            if (result.success.exitCode !== 0)
              return {
                installed: false,
                message: `The installer stopped with an error. Run ${chosen.command} on this machine instead.\n${result.success.output.trim().slice(-MAX_OUTPUT_CHARS)}`,
              };
            return { installed: true, message: "uv is installed." };
          }),
        ),
    });
  });

export const layer: Layer.Layer<
  RuntimeInstaller,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = Layer.effect(
  RuntimeInstaller,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    return yield* make({
      platform,
      runner: {
        exists: (path) => fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
        run: (program, args) =>
          Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(program, [...args], { extendEnv: true }),
              );
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [
                  child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                  child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                  child.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return { exitCode: Number(exitCode), output: `${stdout}\n${stderr}` };
            }),
          ).pipe(
            Effect.timeout("5 minutes"),
            Effect.mapError((cause) => new InstallerSpawnError({ cause })),
          ),
      },
    });
  }),
);
