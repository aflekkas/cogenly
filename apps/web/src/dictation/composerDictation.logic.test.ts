import { describe, expect, it } from "vite-plus/test";

import { dictationKeyAction, transcriptEdit } from "./composerDictation.logic";

describe("transcriptEdit", () => {
  it("recovers the inserted transcript at a caret", () => {
    expect(transcriptEdit("fix  bug", { start: 4, end: 4 }, "fix the login bug")).toEqual({
      start: 4,
      end: 4,
      insertion: "the login",
    });
  });

  it("recovers a transcript that replaced a selection", () => {
    expect(transcriptEdit("say OLD now", { start: 4, end: 7 }, "say new words now")).toEqual({
      start: 4,
      end: 7,
      insertion: "new words",
    });
  });

  it("refuses a commit that changed text outside the selection", () => {
    expect(transcriptEdit("abc", { start: 1, end: 1 }, "xbc!")).toBeNull();
  });
});

describe("dictationKeyAction", () => {
  const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key: value,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...modifiers,
  });

  it("cancels on Escape while any run is active, and leaves idle Escape alone", () => {
    expect(dictationKeyAction("preparing", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("recording", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("transcribing", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("idle", key("Escape"))).toBeNull();
  });

  it("finishes on a bare Enter while recording instead of sending", () => {
    expect(dictationKeyAction("recording", key("Enter"))).toBe("stop");
    expect(dictationKeyAction("recording", key("Enter", { shiftKey: true }))).toBeNull();
    expect(dictationKeyAction("idle", key("Enter"))).toBeNull();
    expect(dictationKeyAction("recording", key("Enter", { isComposing: true }))).toBeNull();
  });
});
