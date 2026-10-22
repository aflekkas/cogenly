import type { DesktopDictationBridge, DesktopDictationResult } from "@t3tools/contracts";
import {
  VoiceInputController,
  VoiceTranscriptionError,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
} from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopVoiceTranscriber } from "./desktopVoiceTranscriber";

function fakeBridge(overrides: Partial<DesktopDictationBridge> = {}): DesktopDictationBridge {
  return {
    isAvailable: async () => true,
    requestMicrophoneAccess: async () => ({ granted: true, canAskAgain: false }),
    prepare: async () => ({ ok: true, value: "en_US" }),
    transcribe: async () => ({ ok: true, value: "hello world" }),
    cancel: async () => {},
    ...overrides,
  };
}

const AUDIO = new Uint8Array([1, 2, 3]);

describe("createDesktopVoiceTranscriber", () => {
  it("binds the helper's resolved locale and sends the recording's bytes", async () => {
    const transcribe = vi.fn(async () => ({ ok: true, value: "hi" }) as const);
    const transcriber = createDesktopVoiceTranscriber(fakeBridge({ transcribe }), {
      locale: () => "en-GB",
      readRecording: (uri) => (uri === "dictation:1" ? AUDIO : null),
    });
    const prepared = await transcriber.prepare({ signal: new AbortController().signal });
    expect(prepared.locale).toBe("en_US");
    await expect(
      prepared.transcribe("dictation:1", { signal: new AbortController().signal }),
    ).resolves.toBe("hi");
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en_US", audio: AUDIO }),
    );
  });

  it("surfaces helper failures with their contract code", async () => {
    const transcriber = createDesktopVoiceTranscriber(
      fakeBridge({
        prepare: async () => ({ ok: false, code: "unsupported-locale", message: "No model." }),
      }),
      { locale: () => "xx", readRecording: () => AUDIO },
    );
    const failure = await transcriber
      .prepare({ signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VoiceTranscriptionError);
    expect((failure as VoiceTranscriptionError).code).toBe("unsupported-locale");
  });

  it("stops the helper run on abort and settles as cancelled once it has stopped", async () => {
    let settle: (result: DesktopDictationResult) => void = () => {};
    const cancel = vi.fn(async () => settle({ ok: false, code: "cancelled", message: "" }));
    const transcriber = createDesktopVoiceTranscriber(
      fakeBridge({
        prepare: ({ requestId }) =>
          new Promise((resolve) => {
            settle = resolve;
            expect(requestId).toMatch(/^dictation-/);
          }),
        cancel,
      }),
      { locale: () => "en-US", readRecording: () => AUDIO },
    );
    const abort = new AbortController();
    const pending = transcriber.prepare({ signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("voice input with the desktop transcriber", () => {
  it("inserts the transcript at the caret with word spacing", async () => {
    let draft: VoiceDraftSnapshot = {
      ownerKey: "thread-1",
      text: "please the tests",
      selection: { start: 6, end: 6 },
      revision: 0,
    };
    const recordings = new Map<string, Uint8Array>();
    const recorder: VoiceRecorder & { uri: string | null } = {
      uri: null,
      prepareToRecordAsync: async () => {},
      record: () => {},
      stop: async () => {
        recorder.uri = "dictation:1";
        recordings.set("dictation:1", AUDIO);
      },
    };
    const states: VoiceInputState["phase"][] = [];
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () =>
        createDesktopVoiceTranscriber(fakeBridge({ transcribe: async () => fixed("fix") }), {
          locale: () => "en-US",
          readRecording: (uri) => recordings.get(uri) ?? null,
        }),
      requestPermission: async () => ({ granted: true, canAskAgain: false }),
      configureRecording: async () => {},
      releaseRecording: async () => {},
      deleteRecording: (uri) => recordings.delete(uri),
      readDraft: () => draft,
      commitDraft: (text, selection) => {
        draft = { ...draft, text, selection };
      },
      onStateChange: (state) => states.push(state.phase),
    });

    await controller.start();
    expect(controller.currentState.phase).toBe("recording");
    await controller.stop();

    expect(draft.text).toBe("please fix the tests");
    expect(draft.selection).toEqual({ start: 10, end: 10 });
    expect(states).toEqual(["preparing", "recording", "transcribing", "idle"]);
    // The recording is released once its transcript lands.
    expect(recordings.size).toBe(0);
  });
});

function fixed(value: string): DesktopDictationResult {
  return { ok: true, value };
}
