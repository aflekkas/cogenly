// @effect-diagnostics globalTimers:off -- Dev-only stand-in that paces synthetic speech.
import type {
  DesktopDictationBridge,
  DesktopDictationResult,
  DesktopDictationStreamEvent,
} from "@cogenly/contracts";

import type { DictationCaptureHandlers, DictationMicrophone } from "./browserDictationMicrophone";

const MOCK_PHRASES = [
  "Hello from the dictation mock.",
  "Each word shows up as volatile text first",
  "and settles into the draft when the segment is final.",
  "Click anywhere in the composer and keep talking.",
];
const WORD_MS = 220;
const SETTLE_MS = 450;
const PAUSE_MS = 700;

/**
 * A dev-build stand-in for the desktop speech helper, so live dictation can be
 * exercised in a browser without a microphone. It ignores the audio and "hears"
 * canned phrases word by word, like the helper's partial and final results.
 * Pair it with `SyntheticDictationMicrophone`.
 */
export function createDevDictationBridge(): DesktopDictationBridge {
  const listeners = new Set<(event: DesktopDictationStreamEvent) => void>();
  const runs = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout> | null;
      words: string[];
      settle: (result: DesktopDictationResult) => void;
    }
  >();
  const emit = (event: DesktopDictationStreamEvent) => {
    for (const listener of listeners) listener(event);
  };
  // Like the helper, segments after the first carry their leading space.
  const segmentText = (words: readonly string[], first: boolean) =>
    `${first ? "" : " "}${words.join(" ")}`;

  return {
    isAvailable: async () => true,
    requestMicrophoneAccess: async () => ({ granted: true, canAskAgain: false }),
    startStream: ({ requestId, locale }) =>
      new Promise<DesktopDictationResult>((resolve) => {
        let phrase = 0;
        let word = 0;
        const run = {
          timer: null as ReturnType<typeof setTimeout> | null,
          words: [] as string[],
          settle: (result: DesktopDictationResult) => {
            if (run.timer !== null) clearTimeout(run.timer);
            runs.delete(requestId);
            resolve(result);
          },
        };
        runs.set(requestId, run);
        const step = () => {
          const words = MOCK_PHRASES[phrase % MOCK_PHRASES.length]!.split(" ");
          if (word < words.length) {
            word += 1;
            run.words = words.slice(0, word);
            emit({ requestId, type: "partial", text: segmentText(run.words, phrase === 0) });
            run.timer = setTimeout(step, word === words.length ? SETTLE_MS : WORD_MS);
            return;
          }
          emit({ requestId, type: "final", text: segmentText(words, phrase === 0) });
          run.words = [];
          phrase += 1;
          word = 0;
          run.timer = setTimeout(step, PAUSE_MS);
        };
        run.timer = setTimeout(() => {
          emit({ requestId, type: "ready", locale: locale.replaceAll("-", "_") });
          step();
        }, 300);
      }),
    sendStreamAudio: () => {},
    finishStream: async (requestId) => {
      const run = runs.get(requestId);
      if (!run) return;
      if (run.timer !== null) clearTimeout(run.timer);
      // Whatever was "heard" so far settles, the way the helper finalizes at EOF.
      run.timer = setTimeout(() => {
        if (run.words.length > 0) {
          emit({ requestId, type: "final", text: segmentText(run.words, false) });
        }
        run.settle({ ok: true, value: "" });
      }, 250);
    },
    onStreamEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: async (requestId) =>
      runs.get(requestId)?.settle({ ok: false, code: "cancelled", message: "Cancelled." }),
  };
}

/**
 * A dev-build microphone that needs no hardware: it "speaks" in phrases of
 * syllable-like bursts so the recording waveform can be seen.
 */
export class SyntheticDictationMicrophone implements DictationMicrophone {
  private startedAt: number | null = null;

  async start(_handlers: DictationCaptureHandlers): Promise<void> {
    this.startedAt = performance.now();
  }

  async stop(): Promise<void> {
    this.startedAt = null;
  }

  readLevel(): number {
    if (this.startedAt === null) return 0;
    const seconds = (performance.now() - this.startedAt) / 1000;
    // 2.4 s phrases with 0.8 s pauses; the first half second is silence.
    const phrase = (seconds - 0.5) % 3.2;
    if (seconds < 0.5 || phrase > 2.4) return 0.05 + Math.random() * 0.06;
    const syllable = Math.abs(Math.sin(seconds * Math.PI * 4.3));
    const stress = 0.7 + 0.3 * Math.sin(seconds * Math.PI * 0.9);
    return Math.min(1, 0.3 + 0.5 * syllable * stress + Math.random() * 0.1);
  }
}
