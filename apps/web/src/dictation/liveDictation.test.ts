import type {
  DesktopDictationBridge,
  DesktopDictationResult,
  DesktopDictationStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DictationCaptureHandlers, DictationMicrophone } from "./browserDictationMicrophone";
import { LiveDictationSession, type LiveDictationPhase } from "./liveDictation";

function harness(options: { granted?: boolean } = {}) {
  const listeners = new Set<(event: DesktopDictationStreamEvent) => void>();
  const sent: Uint8Array[] = [];
  const calls: string[] = [];
  let settle: (result: DesktopDictationResult) => void = () => {};
  let requestId = "";
  const bridge: DesktopDictationBridge = {
    isAvailable: async () => true,
    requestMicrophoneAccess: async () => ({
      granted: options.granted ?? true,
      canAskAgain: false,
    }),
    startStream: (input) => {
      requestId = input.requestId;
      calls.push("start");
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    sendStreamAudio: (_id, audio) => void sent.push(audio),
    finishStream: async () => void calls.push("finish"),
    onStreamEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: async () => {
      calls.push("cancel");
      settle({ ok: false, code: "cancelled", message: "Cancelled." });
    },
  };
  let capture: DictationCaptureHandlers | null = null;
  const microphone: DictationMicrophone = {
    start: async (handlers) => {
      capture = handlers;
    },
    stop: async () => {
      capture = null;
    },
    readLevel: () => 0.5,
  };
  const phases: LiveDictationPhase[] = [];
  const partials: Array<string | null> = [];
  const finals: string[] = [];
  const errors: string[] = [];
  const session = new LiveDictationSession(bridge, microphone, () => "en-US", {
    onPhase: (phase) => phases.push(phase),
    onPartial: (text) => partials.push(text),
    onFinal: (text) => finals.push(text),
    onError: (error) => errors.push(error.message),
  });
  const emit = (event: { type: "partial" | "final"; text: string }) => {
    for (const listener of listeners) listener({ ...event, requestId });
  };
  return {
    session,
    calls,
    sent,
    phases,
    partials,
    finals,
    errors,
    emit,
    settle: (result: DesktopDictationResult) => settle(result),
    capture: () => capture,
  };
}

describe("LiveDictationSession", () => {
  it("streams the microphone and reports partial and final text while recording", async () => {
    const run = harness();
    await run.session.start();
    expect(run.session.phase).toBe("recording");
    run.capture()?.onAudio(new Uint8Array([1, 2]));
    expect(run.sent).toHaveLength(1);

    run.emit({ type: "partial", text: "Hello" });
    run.emit({ type: "partial", text: "Hello there" });
    run.emit({ type: "final", text: "Hello there." });
    expect(run.partials).toEqual(["Hello", "Hello there", null]);
    expect(run.finals).toEqual(["Hello there."]);
  });

  it("finishes by flushing the helper and resolves once the last segment lands", async () => {
    const run = harness();
    await run.session.start();
    const finished = run.session.finish();
    expect(run.session.phase).toBe("finishing");
    expect(run.calls).toContain("finish");
    expect(run.capture()).toBeNull();

    run.emit({ type: "final", text: " and more." });
    run.settle({ ok: true, value: "" });
    await expect(finished).resolves.toBe(true);
    expect(run.finals).toEqual([" and more."]);
    expect(run.phases.at(-1)).toBe("idle");
  });

  it("cancel drops the volatile text, stops the helper and ignores later events", async () => {
    const run = harness();
    await run.session.start();
    run.emit({ type: "partial", text: "never mind" });
    const finished = run.session.finish();
    run.session.cancel();
    await expect(finished).resolves.toBe(false);
    expect(run.calls).toContain("cancel");
    expect(run.partials.at(-1)).toBeNull();
    run.emit({ type: "final", text: "late" });
    expect(run.finals).toEqual([]);
    expect(run.session.phase).toBe("idle");
  });

  it("reports a helper failure and a refused microphone", async () => {
    const failing = harness();
    await failing.session.start();
    failing.settle({ ok: false, code: "unsupported-locale", message: "No model." });
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.errors).toEqual(["Dictation is not available for this language."]);
    expect(failing.session.phase).toBe("idle");

    const refused = harness({ granted: false });
    await refused.session.start();
    expect(refused.calls).not.toContain("start");
    expect(refused.errors).toEqual(["Microphone access is required for dictation."]);
  });
});
