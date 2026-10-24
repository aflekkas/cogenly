import type {
  DesktopDictationErrorCode,
  DesktopDictationResult,
  DesktopDictationStreamInput,
  DesktopMicrophoneAccess,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const HELPER_RELATIVE_PATH = ["speech-helper", "cogenly-speech"] as const;

const HelperErrorCode = Schema.Literals([
  "unavailable",
  "unsupported-locale",
  "preparation-failed",
  "transcription-failed",
]);
const isHelperErrorCode = Schema.is(HelperErrorCode);

/** `status` prints one JSON object; see native/speech-helper/main.swift. */
const StatusOutput = Schema.Struct({ available: Schema.Boolean });
const decodeStatusOutput = Schema.decodeUnknownOption(Schema.fromJsonString(StatusOutput));

/** One stdout line of `cogenly-speech stream`. */
const StreamLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), locale: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["partial", "final"]), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("done") }),
  Schema.Struct({ type: Schema.Literal("error"), code: Schema.String, message: Schema.String }),
]);
const decodeStreamLine = Schema.decodeUnknownOption(Schema.fromJsonString(StreamLine));

const failure = (code: DesktopDictationErrorCode, message: string): DesktopDictationResult => ({
  ok: false,
  code,
  message,
});

/** A stream event before the IPC layer addresses it to its run. */
export type StreamEventBody =
  | { readonly type: "ready"; readonly locale: string }
  | { readonly type: "partial" | "final"; readonly text: string };

export type StreamLineOutcome =
  | { readonly kind: "event"; readonly event: StreamEventBody }
  | { readonly kind: "end"; readonly result: DesktopDictationResult }
  | { readonly kind: "ignore" };

/** Maps one line of the streaming helper's output to an event or the run's end. */
export function parseStreamLine(line: string): StreamLineOutcome {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "ignore" };
  const output = decodeStreamLine(trimmed);
  if (output._tag === "None") return { kind: "ignore" };
  const value = output.value;
  switch (value.type) {
    case "ready":
      return { kind: "event", event: { type: "ready", locale: value.locale } };
    case "partial":
    case "final":
      return { kind: "event", event: { type: value.type, text: value.text } };
    case "done":
      return { kind: "end", result: { ok: true, value: "" } };
    case "error":
      return {
        kind: "end",
        result: failure(
          isHelperErrorCode(value.code) ? value.code : "transcription-failed",
          value.message,
        ),
      };
  }
}

/** Maps Electron's TCC status for the prompt-or-settings decision. */
export function microphoneAccessFromStatus(
  status: ReturnType<typeof Electron.systemPreferences.getMediaAccessStatus>,
): DesktopMicrophoneAccess | null {
  if (status === "granted") return { granted: true, canAskAgain: false };
  if (status === "not-determined") return null;
  return { granted: false, canAskAgain: false };
}

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly isAvailable: Effect.Effect<boolean>;
    readonly requestMicrophoneAccess: Effect.Effect<DesktopMicrophoneAccess>;
    /** Runs the live helper until it finishes, reporting through `emit`. */
    readonly stream: (
      input: DesktopDictationStreamInput,
      emit: (event: StreamEventBody) => void,
    ) => Effect.Effect<DesktopDictationResult>;
    /** Queues PCM16 audio for a running stream; audio for an unknown run is dropped. */
    readonly streamAudio: (requestId: string, audio: Uint8Array) => void;
    /** Closes the run's audio so the helper finalizes and exits. */
    readonly finishStream: (requestId: string) => Effect.Effect<void>;
    /** Stops the named run; its pending call resolves as `cancelled`. */
    readonly cancel: (requestId: string) => Effect.Effect<void>;
  }
>()("@cogenly/desktop/dictation/DesktopDictation") {}

export const layer = Layer.effect(
  DesktopDictation,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcess.Environment;

    const relative = environment.path.join(...HELPER_RELATIVE_PATH);
    const candidates =
      environment.platform !== "darwin"
        ? []
        : environment.isPackaged
          ? [environment.path.join(environment.resourcesPath, relative)]
          : [
              // Built by apps/desktop/scripts/build-speech-helper.mjs on dev launch.
              environment.path.join(
                environment.rootDir,
                "native",
                "speech-helper",
                "build",
                environment.processArch,
                "cogenly-speech",
              ),
              ...environment.resolveResourcePathCandidates(relative),
            ];
    let helperPath: string | undefined;
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        helperPath = candidate;
        break;
      }
    }

    const runHelper = (args: readonly string[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (helperPath === undefined) return "";
          const handle = yield* spawner.spawn(
            ChildProcess.make(helperPath, [...args], {
              stdin: "ignore",
              stderr: "ignore",
              env: hostEnvironment,
            }),
          );
          const [stdout] = yield* Effect.all(
            [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return stdout;
        }),
      ).pipe(Effect.orElseSucceed(() => ""));

    const cancellations = new Map<string, Deferred.Deferred<void>>();
    const streams = new Map<string, Queue.Queue<Uint8Array, Cause.Done>>();
    const cancellable = (
      requestId: string,
      work: Effect.Effect<DesktopDictationResult>,
    ): Effect.Effect<DesktopDictationResult> =>
      Effect.gen(function* () {
        const cancelled = yield* Deferred.make<void>();
        const previous = cancellations.get(requestId);
        if (previous) Deferred.doneUnsafe(previous, Effect.void);
        cancellations.set(requestId, cancelled);
        // Losing the race interrupts the helper's scope, which kills its process.
        return yield* Effect.raceFirst(
          work,
          Deferred.await(cancelled).pipe(
            Effect.as(failure("cancelled", "Voice transcription was cancelled.")),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (cancellations.get(requestId) === cancelled) cancellations.delete(requestId);
            }),
          ),
        );
      });

    let availability: boolean | undefined;
    const isAvailable = Effect.gen(function* () {
      if (helperPath === undefined) return false;
      if (availability !== undefined) return availability;
      const output = decodeStatusOutput((yield* runHelper(["status"])).trim());
      availability = output._tag === "Some" && output.value.available;
      return availability;
    });

    return DesktopDictation.of({
      isAvailable,
      requestMicrophoneAccess: Effect.gen(function* () {
        const current = microphoneAccessFromStatus(
          Electron.systemPreferences.getMediaAccessStatus("microphone"),
        );
        if (current) return current;
        const granted = yield* Effect.promise(() =>
          Electron.systemPreferences.askForMediaAccess("microphone"),
        );
        return { granted, canAskAgain: false };
      }),
      stream: ({ requestId, locale }, emit) =>
        cancellable(
          requestId,
          Effect.scoped(
            Effect.gen(function* () {
              if (helperPath === undefined) {
                return failure("unavailable", "The speech helper is not installed.");
              }
              const audio = yield* Queue.unbounded<Uint8Array, Cause.Done>();
              streams.set(requestId, audio);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  if (streams.get(requestId) === audio) streams.delete(requestId);
                  Queue.endUnsafe(audio);
                }),
              );
              const handle = yield* spawner.spawn(
                ChildProcess.make(helperPath, ["stream", "--locale", locale], {
                  // Ending the queue closes stdin, which tells the helper to finalize.
                  stdin: Stream.fromQueue(audio),
                  stderr: "ignore",
                  env: hostEnvironment,
                }),
              );
              let result: DesktopDictationResult | null = null;
              yield* Effect.all(
                [
                  handle.stdout.pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((line) =>
                      Effect.sync(() => {
                        const outcome = parseStreamLine(line);
                        if (outcome.kind === "event") emit(outcome.event);
                        else if (outcome.kind === "end") result = outcome.result;
                      }),
                    ),
                  ),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return (
                result ?? failure("transcription-failed", "The speech helper stopped unexpectedly.")
              );
            }),
          ).pipe(
            Effect.orElseSucceed(() =>
              failure("transcription-failed", "Could not run the speech helper."),
            ),
          ),
        ),
      streamAudio: (requestId, chunk) => {
        const audio = streams.get(requestId);
        if (audio) Queue.offerUnsafe(audio, chunk);
      },
      finishStream: (requestId) =>
        Effect.sync(() => {
          const audio = streams.get(requestId);
          if (audio) Queue.endUnsafe(audio);
        }),
      cancel: (requestId) =>
        Effect.sync(() => {
          const cancelled = cancellations.get(requestId);
          if (cancelled) Deferred.doneUnsafe(cancelled, Effect.void);
        }),
    });
  }),
);
