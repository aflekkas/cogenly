import { describe, expect, it } from "@effect/vitest";

import { microphoneAccessFromStatus, parseStreamLine } from "./DesktopDictation.ts";

describe("parseStreamLine", () => {
  it("forwards readiness, volatile text and settled segments as events", () => {
    expect(parseStreamLine('{"type":"ready","locale":"en_US"}\n')).toEqual({
      kind: "event",
      event: { type: "ready", locale: "en_US" },
    });
    expect(parseStreamLine('{"type":"partial","text":" This is"}')).toEqual({
      kind: "event",
      event: { type: "partial", text: " This is" },
    });
    expect(parseStreamLine('{"type":"final","text":"Hello there."}')).toEqual({
      kind: "event",
      event: { type: "final", text: "Hello there." },
    });
  });

  it("ends the run on done or error, keeping known error codes", () => {
    expect(parseStreamLine('{"type":"done"}')).toEqual({
      kind: "end",
      result: { ok: true, value: "" },
    });
    expect(
      parseStreamLine('{"type":"error","code":"unsupported-locale","message":"No model."}'),
    ).toEqual({
      kind: "end",
      result: { ok: false, code: "unsupported-locale", message: "No model." },
    });
    expect(parseStreamLine('{"type":"error","code":"usage","message":"bad"}')).toEqual({
      kind: "end",
      result: { ok: false, code: "transcription-failed", message: "bad" },
    });
  });

  it("ignores blank and malformed lines", () => {
    expect(parseStreamLine("")).toEqual({ kind: "ignore" });
    expect(parseStreamLine("not json")).toEqual({ kind: "ignore" });
    expect(parseStreamLine('{"type":"partial"}')).toEqual({ kind: "ignore" });
  });
});

describe("microphoneAccessFromStatus", () => {
  it("prompts only while macOS has not asked, and sends denials to System Settings", () => {
    expect(microphoneAccessFromStatus("granted")).toEqual({ granted: true, canAskAgain: false });
    expect(microphoneAccessFromStatus("not-determined")).toBeNull();
    expect(microphoneAccessFromStatus("denied")).toEqual({ granted: false, canAskAgain: false });
    expect(microphoneAccessFromStatus("restricted")).toEqual({
      granted: false,
      canAskAgain: false,
    });
  });
});
