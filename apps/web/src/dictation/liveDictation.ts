// @effect-diagnostics globalTimers:off -- The recording and flush limits are plain timers owned by one run.
import type { DesktopDictationBridge, DesktopDictationResult } from "@t3tools/contracts";

import type { DictationMicrophone } from "./browserDictationMicrophone";

/** Live runs stream, so they can be long; this only stops a forgotten one. */
export const DICTATION_RECORDING_LIMIT_MS = 10 * 60 * 1000;
// The helper finalizes in well under a second; a hung one must not hold the composer.
const FINISH_TIMEOUT_MS = 10_000;

export type LiveDictationPhase = "idle" | "starting" | "recording" | "finishing";

export interface LiveDictationError {
  readonly message: string;
  /** "settings" when macOS refused the microphone; "retry" for anything worth trying again. */
  readonly action: "retry" | "settings" | null;
}

export interface LiveDictationCallbacks {
  readonly onPhase: (phase: LiveDictationPhase) => void;
  /** Volatile text for the current segment, or null to clear it. */
  readonly onPartial: (text: string | null) => void;
  /** A settled segment, to insert at the caret. */
  readonly onFinal: (text: string) => void;
  /** `retry` starts a fresh run. */
  readonly onError: (error: LiveDictationError, retry: () => void) => void;
}

interface Run {
  readonly requestId: string;
  readonly unsubscribe: () => void;
  readonly ended: Promise<void>;
  /** True once the helper settled everything it heard, rather than being cancelled. */
  completed: boolean;
  limitTimer: ReturnType<typeof setTimeout> | null;
}

let nextRequestId = 0;
// One microphone, so one run app-wide; a second composer's start finishes the first.
let activeFinish: (() => Promise<boolean>) | null = null;

function errorMessage(result: Extract<DesktopDictationResult, { ok: false }>): string {
  switch (result.code) {
    case "unsupported-locale":
      return "Dictation is not available for this language.";
    case "preparation-failed":
      return "Could not download the dictation model.";
    case "unavailable":
      return "Dictation is not available on this Mac.";
    default:
      return "Dictation stopped unexpectedly.";
  }
}

/**
 * One composer's live dictation: streams the microphone to the speech helper
 * and reports volatile and settled text as it arrives. The composer stays
 * editable throughout; the caller decides where text lands.
 */
export class LiveDictationSession {
  private currentPhase: LiveDictationPhase = "idle";
  private run: Run | null = null;
  // Bumped by every start and cancel, so a start whose permission prompt was cancelled stays dead.
  private attempt = 0;
  private readonly finishFromElsewhere = () => this.finish();

  constructor(
    private readonly bridge: DesktopDictationBridge,
    private readonly microphone: DictationMicrophone,
    private readonly locale: () => string,
    private readonly callbacks: LiveDictationCallbacks,
  ) {}

  get phase(): LiveDictationPhase {
    return this.currentPhase;
  }

  readLevel(): number {
    return this.currentPhase === "recording" ? this.microphone.readLevel() : 0;
  }

  async start(): Promise<void> {
    if (this.currentPhase !== "idle") return;
    if (activeFinish && activeFinish !== this.finishFromElsewhere) void activeFinish();
    activeFinish = this.finishFromElsewhere;
    this.setPhase("starting");
    const attempt = ++this.attempt;
    nextRequestId += 1;
    const requestId = `dictation-${nextRequestId}`;

    let access: Awaited<ReturnType<DesktopDictationBridge["requestMicrophoneAccess"]>>;
    try {
      access = await this.bridge.requestMicrophoneAccess();
    } catch {
      access = { granted: false, canAskAgain: true };
    }
    if (attempt !== this.attempt) return;
    if (!access.granted) {
      this.fail({
        message: "Microphone access is required for dictation.",
        action: access.canAskAgain ? "retry" : "settings",
      });
      return;
    }

    const unsubscribe = this.bridge.onStreamEvent((event) => {
      if (this.run?.requestId !== event.requestId) return;
      if (event.type === "partial") this.callbacks.onPartial(event.text);
      else if (event.type === "final") {
        this.callbacks.onPartial(null);
        this.callbacks.onFinal(event.text);
      }
    });
    // The helper loads its model while the microphone opens; audio sent before
    // it is ready waits in the pipe, so nothing said early is lost.
    const ended = this.bridge
      .startStream({ requestId, locale: this.locale() })
      .catch((): DesktopDictationResult => ({
        ok: false,
        code: "transcription-failed",
        message: "The speech helper could not start.",
      }))
      .then((result) => this.ended(run, result));
    const run: Run = { requestId, unsubscribe, ended, completed: false, limitTimer: null };
    this.run = run;

    try {
      await this.microphone.start({
        onAudio: (pcm) => {
          if (this.run === run) this.bridge.sendStreamAudio(requestId, pcm);
        },
        onInterrupted: () => void this.finish(),
      });
    } catch {
      if (this.run !== run) return;
      this.teardown(run, true);
      this.fail({ message: "Could not open the microphone.", action: "retry" });
      return;
    }
    if (this.run !== run) {
      void this.microphone.stop();
      return;
    }
    run.limitTimer = setTimeout(() => void this.finish(), DICTATION_RECORDING_LIMIT_MS);
    this.setPhase("recording");
  }

  /**
   * Stops listening and waits for the helper to settle what it heard. True when
   * every segment landed (or nothing had been heard yet); false when the run
   * was cancelled or failed.
   */
  async finish(): Promise<boolean> {
    const run = this.run;
    if (!run || this.currentPhase === "starting") {
      // Nothing was heard yet; there is nothing to settle.
      if (this.currentPhase !== "idle") this.cancel();
      return true;
    }
    if (this.currentPhase === "recording") {
      this.setPhase("finishing");
      void this.microphone.stop();
      void this.bridge.finishStream(run.requestId);
      const timeout = setTimeout(() => {
        if (this.run === run) this.cancel();
      }, FINISH_TIMEOUT_MS);
      void run.ended.finally(() => clearTimeout(timeout));
    }
    await run.ended;
    return run.completed;
  }

  /** Stops at once, dropping the volatile text; settled segments stay where they landed. */
  cancel(): void {
    this.attempt += 1;
    const run = this.run;
    if (run) this.teardown(run, true);
    if (this.currentPhase !== "idle") this.setPhase("idle");
    if (activeFinish === this.finishFromElsewhere) activeFinish = null;
  }

  dispose(): void {
    this.cancel();
  }

  private ended(run: Run, result: DesktopDictationResult): void {
    if (this.run !== run) return;
    run.completed = result.ok;
    this.teardown(run, false);
    this.setPhase("idle");
    if (activeFinish === this.finishFromElsewhere) activeFinish = null;
    if (!result.ok && result.code !== "cancelled") {
      this.callbacks.onError({ message: errorMessage(result), action: "retry" }, () => {
        void this.start();
      });
    }
  }

  private teardown(run: Run, cancelHelper: boolean): void {
    this.run = null;
    if (run.limitTimer !== null) clearTimeout(run.limitTimer);
    run.unsubscribe();
    void this.microphone.stop();
    if (cancelHelper) void this.bridge.cancel(run.requestId);
    this.callbacks.onPartial(null);
  }

  private fail(error: LiveDictationError): void {
    this.setPhase("idle");
    if (activeFinish === this.finishFromElsewhere) activeFinish = null;
    this.callbacks.onError(error, () => {
      void this.start();
    });
  }

  private setPhase(phase: LiveDictationPhase): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.callbacks.onPhase(phase);
  }
}
