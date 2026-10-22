import type {
  DesktopDictationErrorCode,
  DesktopDictationPrepareInput,
  DesktopDictationResult,
  DesktopDictationTranscribeInput,
  DesktopMicrophoneAccess,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

/** One JSON object per helper run; see native/speech-helper/main.swift. */
const HelperOutput = Schema.Union([
  Schema.Struct({ available: Schema.Boolean }),
  Schema.Struct({ locale: Schema.String }),
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
const decodeHelperOutput = Schema.decodeUnknownOption(Schema.fromJsonString(HelperOutput));

const failure = (code: DesktopDictationErrorCode, message: string): DesktopDictationResult => ({
  ok: false,
  code,
  message,
});

/** Maps the helper's single stdout line to the bridge result. */
export function parseHelperResult(
  stdout: string,
  field: "locale" | "text",
): DesktopDictationResult {
  const fallback: DesktopDictationErrorCode =
    field === "locale" ? "preparation-failed" : "transcription-failed";
  const output = decodeHelperOutput(stdout.trim());
  if (output._tag === "None") return failure(fallback, "The speech helper returned no result.");
  const value = output.value;
  if ("error" in value) {
    const code = isHelperErrorCode(value.error.code) ? value.error.code : fallback;
    return failure(code, value.error.message);
  }
  if (field === "locale" && "locale" in value) return { ok: true, value: value.locale };
  if (field === "text" && "text" in value) return { ok: true, value: value.text };
  return failure(fallback, "The speech helper returned an unexpected result.");
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
    readonly prepare: (
      input: DesktopDictationPrepareInput,
    ) => Effect.Effect<DesktopDictationResult>;
    readonly transcribe: (
      input: DesktopDictationTranscribeInput,
    ) => Effect.Effect<DesktopDictationResult>;
    /** Stops the named run; its pending call resolves as `cancelled`. */
    readonly cancel: (requestId: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/dictation/DesktopDictation") {}

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
      const output = decodeHelperOutput((yield* runHelper(["status"])).trim());
      availability =
        output._tag === "Some" && "available" in output.value && output.value.available;
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
      prepare: ({ requestId, locale }) =>
        cancellable(
          requestId,
          runHelper(["prepare", "--locale", locale]).pipe(
            Effect.map((stdout) => parseHelperResult(stdout, "locale")),
          ),
        ),
      transcribe: ({ requestId, locale, audio }) =>
        cancellable(
          requestId,
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fileSystem.makeTempDirectoryScoped({
                prefix: "cogenly-dictation-",
              });
              const file = environment.path.join(directory, "recording.wav");
              yield* fileSystem.writeFile(file, audio);
              const stdout = yield* runHelper(["transcribe", "--locale", locale, file]);
              return parseHelperResult(stdout, "text");
            }),
          ).pipe(
            Effect.orElseSucceed(() =>
              failure("transcription-failed", "Could not save the recording for transcription."),
            ),
          ),
        ),
      cancel: (requestId) =>
        Effect.sync(() => {
          const cancelled = cancellations.get(requestId);
          if (cancelled) Deferred.doneUnsafe(cancelled, Effect.void);
        }),
    });
  }),
);
