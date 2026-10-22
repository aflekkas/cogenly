// @effect-diagnostics globalTimers:off -- Dev-only stand-in that simulates helper latency.
import type { VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import type { DesktopDictationBridge, DesktopDictationResult } from "@t3tools/contracts";

import type { DictationRecorder } from "./browserVoiceRecorder";
import { DICTATION_SAMPLE_RATE, encodeWav } from "./dictationAudio";

/**
 * A dev-build stand-in for the desktop speech helper, so the composer's dictation
 * UI can be exercised in a browser. Pair it with `SyntheticVoiceRecorder`.
 */
export function createDevDictationBridge(): DesktopDictationBridge {
  const pending = new Map<string, (result: DesktopDictationResult) => void>();
  const settleAfter = (requestId: string, ms: number, result: DesktopDictationResult) =>
    new Promise<DesktopDictationResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(result);
      }, ms);
      pending.set(requestId, (cancelled) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(cancelled);
      });
    });
  return {
    isAvailable: async () => true,
    requestMicrophoneAccess: async () => ({ granted: true, canAskAgain: false }),
    prepare: ({ requestId, locale }) =>
      settleAfter(requestId, 150, { ok: true, value: locale.replaceAll("-", "_") }),
    transcribe: ({ requestId, audio }) =>
      settleAfter(requestId, 600, {
        ok: true,
        value: `hello from the dictation mock (${Math.round(audio.byteLength / 1024)} KB)`,
      }),
    cancel: async (requestId) =>
      pending.get(requestId)?.({ ok: false, code: "cancelled", message: "Cancelled." }),
  };
}

/**
 * A dev-build recorder that needs no microphone: it "speaks" in phrases of
 * syllable-like bursts so the recording waveform can be seen, and finishes as a
 * silent WAV as long as the take.
 */
export class SyntheticVoiceRecorder implements DictationRecorder {
  uri: string | null = null;

  private startedAt: number | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRecordingId = 0;
  private readonly recordings = new Map<string, Uint8Array>();

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  async configure(): Promise<void> {}

  async release(): Promise<void> {
    this.clearLimit();
    this.startedAt = null;
  }

  async prepareToRecordAsync(): Promise<void> {
    this.uri = null;
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    this.startedAt = performance.now();
    this.limitTimer = setTimeout(() => {
      this.finish();
      this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
    }, forDuration * 1000);
  }

  async stop(): Promise<void> {
    this.finish();
  }

  readRecording(uri: string): Uint8Array | null {
    return this.recordings.get(uri) ?? null;
  }

  deleteRecording(uri: string): void {
    this.recordings.delete(uri);
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

  private finish(): void {
    if (this.startedAt === null) return;
    const seconds = (performance.now() - this.startedAt) / 1000;
    this.clearLimit();
    this.startedAt = null;
    this.nextRecordingId += 1;
    const uri = `dictation:synthetic-${this.nextRecordingId}`;
    const silence = new Float32Array(Math.round(seconds * DICTATION_SAMPLE_RATE));
    this.recordings.set(uri, encodeWav([silence], DICTATION_SAMPLE_RATE));
    this.uri = uri;
  }

  private clearLimit(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}
