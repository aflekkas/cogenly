/**
 * The OS boundary for computer use: one JXA program per action, plus
 * `screencapture`/`sips` for screenshots and `open` for launching apps and
 * System Settings panes. Everything runs as a child of the server, so macOS
 * attributes it to the app that runs the server (Cogenly for the desktop app).
 * Tests replace this service; nothing above it touches the OS.
 */
import { ComputerUsePermission, ComputerUseUnavailableError } from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { MAC_COMPUTER_SCRIPT } from "./macComputerScript.ts";
import { hostAppName } from "./ComputerUseStatus.ts";

/** A script reply: the value, or the grant macOS refused for this call. */
export type ComputerScriptReply =
  | { readonly _tag: "ok"; readonly value: unknown }
  | { readonly _tag: "missing"; readonly permission: ComputerUsePermission };

export class ComputerHost extends Context.Service<
  ComputerHost,
  {
    readonly platform: NodeJS.Platform;
    /** The app macOS lists the grants under, when it can be told. */
    readonly hostApp: string | null;
    readonly script: (
      input: { readonly op: string; readonly needs?: ComputerUsePermission } & Record<
        string,
        unknown
      >,
      timeout?: Duration.Input,
    ) => Effect.Effect<ComputerScriptReply, ComputerUseUnavailableError>;
    /** A PNG of one display, scaled to `width` pixels (its width in points). */
    readonly capture: (
      display: number,
      width: number,
    ) => Effect.Effect<Uint8Array, ComputerUseUnavailableError>;
    /** `open` with these arguments: an app (`-a`, `-b`) or a settings URL. */
    readonly open: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<void, ComputerUseUnavailableError>;
  }
>()("cogenly-server/computerUse/ComputerHost") {}

const failed = (reason: string, cause?: unknown) =>
  new ComputerUseUnavailableError({
    code: "failed",
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const decoder = new TextDecoder();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isComputerUseUnavailableError = Schema.is(ComputerUseUnavailableError);
const decodeReply = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      value: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.String),
      missing: Schema.optional(ComputerUsePermission),
    }),
  ),
);

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostApp = hostAppName({
    platform,
    executablePath: yield* HostProcess.ExecutablePath,
    environment: yield* HostProcess.Environment,
  });

  const run = (command: string, args: ReadonlyArray<string>, timeout: Duration.Input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, [...args], { stdin: "ignore" }),
        );
        const collect = (stream: typeof child.stdout) =>
          Stream.runFold(
            stream,
            () => "",
            (text, chunk) => text + decoder.decode(chunk),
          );
        const [stdout, stderr, code] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code: Number(code) };
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(failed(`${path.basename(command)} did not finish in time.`)),
      }),
      Effect.mapError((cause) =>
        isComputerUseUnavailableError(cause)
          ? cause
          : failed(`Could not run ${path.basename(command)}.`, cause),
      ),
    );

  const script: ComputerHost["Service"]["script"] = (input, timeout = Duration.seconds(30)) =>
    Effect.gen(function* () {
      const result = yield* run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", MAC_COMPUTER_SCRIPT, encodeJson(input)],
        timeout,
      );
      const line = result.stdout.trim().split("\n").at(-1) ?? "";
      const reply = yield* decodeReply(line).pipe(
        Effect.mapError((cause) =>
          failed(
            result.code === 0
              ? "The computer-use helper returned no result."
              : `The computer-use helper failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`,
            cause,
          ),
        ),
      );
      if (reply.ok) return { _tag: "ok" as const, value: reply.value };
      if (reply.missing !== undefined)
        return { _tag: "missing" as const, permission: reply.missing };
      return yield* failed(reply.error ?? "The action failed.");
    });

  const capture: ComputerHost["Service"]["capture"] = (display, width) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "cogenly-computer-" })
          .pipe(Effect.mapError((cause) => failed("Could not create a screenshot file.", cause)));
        const file = path.join(directory, "screen.png");
        const shot = yield* run(
          "/usr/sbin/screencapture",
          ["-x", "-t", "png", "-D", String(display), file],
          Duration.seconds(20),
        );
        if (shot.code !== 0) {
          return yield* failed(
            `screencapture failed: ${shot.stderr.trim().slice(0, 300) || `exit ${shot.code}`}`,
          );
        }
        // Retina captures are twice the point size; scaling makes pixels and click points agree.
        yield* run(
          "/usr/bin/sips",
          ["--resampleWidth", String(Math.max(1, Math.round(width))), file],
          Duration.seconds(20),
        );
        return yield* fileSystem
          .readFile(file)
          .pipe(Effect.mapError((cause) => failed("Could not read the screenshot.", cause)));
      }),
    );

  const open: ComputerHost["Service"]["open"] = (args) =>
    run("/usr/bin/open", args, Duration.seconds(20)).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.fail(failed(result.stderr.trim().slice(0, 300) || "open failed.")),
      ),
    );

  return ComputerHost.of({ platform, hostApp, script, capture, open });
});

export const layer = Layer.effect(ComputerHost, make);
