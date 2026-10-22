import { describe, expect, it } from "@effect/vitest";

import { microphoneAccessFromStatus, parseHelperResult } from "./DesktopDictation.ts";

describe("parseHelperResult", () => {
  it("returns the field the command produces", () => {
    expect(parseHelperResult('{"locale":"en_US"}\n', "locale")).toEqual({
      ok: true,
      value: "en_US",
    });
    expect(parseHelperResult('{"text":"Hello, world."}', "text")).toEqual({
      ok: true,
      value: "Hello, world.",
    });
  });

  it("keeps the helper's contract error codes and folds unknown ones into the step's failure", () => {
    expect(
      parseHelperResult(
        '{"error":{"code":"unsupported-locale","message":"No model for xx."}}',
        "locale",
      ),
    ).toEqual({ ok: false, code: "unsupported-locale", message: "No model for xx." });
    expect(parseHelperResult('{"error":{"code":"usage","message":"bad"}}', "text")).toEqual({
      ok: false,
      code: "transcription-failed",
      message: "bad",
    });
  });

  it("treats a crashed or silent helper as a failed step", () => {
    expect(parseHelperResult("", "locale")).toMatchObject({
      ok: false,
      code: "preparation-failed",
    });
    expect(parseHelperResult('{"locale":"en_US"}', "text")).toMatchObject({
      ok: false,
      code: "transcription-failed",
    });
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
