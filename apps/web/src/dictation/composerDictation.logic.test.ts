import { describe, expect, it } from "vite-plus/test";

import { dictationKeyAction, spaceDictatedText } from "./composerDictation.logic";

describe("spaceDictatedText", () => {
  it("trims the segment and separates it from the words around the caret", () => {
    expect(spaceDictatedText("", "", " Hello there. ")).toBe("Hello there.");
    expect(spaceDictatedText("fix", "", " the login bug")).toBe(" the login bug");
    expect(spaceDictatedText("fix ", "", " the login bug")).toBe("the login bug");
    expect(spaceDictatedText("fix ", "bug", "the login")).toBe("the login ");
    expect(spaceDictatedText("fix ", " bug", "the login")).toBe("the login");
  });

  it("keeps punctuation and line starts tight", () => {
    expect(spaceDictatedText("done", "", ".")).toBe(".");
    expect(spaceDictatedText("\n", "", "Next")).toBe("Next");
    expect(spaceDictatedText("(", "", "aside")).toBe("aside");
  });

  it("treats a chip as a word and leaves unspaced scripts alone", () => {
    expect(spaceDictatedText("￼", "", "check this")).toBe(" check this");
    expect(spaceDictatedText("日本", "", "語です")).toBe("語です");
  });

  it("drops a segment with no text", () => {
    expect(spaceDictatedText("a", "b", "   ")).toBe("");
  });
});

describe("dictationKeyAction", () => {
  const key = (value: string, isComposing = false) => ({ key: value, isComposing });

  it("cancels on Escape while a run is active, and leaves other keys to the composer", () => {
    expect(dictationKeyAction("starting", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("recording", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("finishing", key("Escape"))).toBe("cancel");
    expect(dictationKeyAction("idle", key("Escape"))).toBeNull();
    expect(dictationKeyAction("recording", key("Enter"))).toBeNull();
    expect(dictationKeyAction("recording", key("Escape", true))).toBeNull();
  });
});
