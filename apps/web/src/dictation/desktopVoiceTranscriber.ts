import type { DesktopDictationBridge, DesktopDictationResult } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

let nextRequestId = 0;

/**
 * Runs `call` as one cancellable helper run: aborting `signal` stops the helper
 * process, and the call settles only after that, as the transcriber contract asks.
 */
async function runCancellable(
  bridge: DesktopDictationBridge,
  signal: AbortSignal,
  call: (requestId: string) => Promise<DesktopDictationResult>,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  nextRequestId += 1;
  const requestId = `dictation-${nextRequestId}`;
  const onAbort = () => void bridge.cancel(requestId);
  signal.addEventListener("abort", onAbort, { once: true });
  let result: DesktopDictationResult;
  try {
    result = await call(requestId);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (!result.ok) throw new VoiceTranscriptionError(result.code, result.message);
  return result.value;
}

/** Transcribes on device through the desktop speech helper. */
export function createDesktopVoiceTranscriber(
  bridge: DesktopDictationBridge,
  options: {
    readonly locale: () => string;
    /** Bytes for a recorder URI; null once the recording was released. */
    readonly readRecording: (uri: string) => Uint8Array | null;
  },
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      const locale = await runCancellable(bridge, signal, (requestId) =>
        bridge.prepare({ requestId, locale: options.locale() }),
      );
      return {
        locale,
        transcribe: (uri, { signal: transcribeSignal }) => {
          const audio = options.readRecording(uri);
          if (!audio) {
            return Promise.reject(
              new VoiceTranscriptionError("transcription-failed", "The recording is missing."),
            );
          }
          return runCancellable(bridge, transcribeSignal, (requestId) =>
            bridge.transcribe({ requestId, locale, audio }),
          );
        },
      };
    },
  };
}
