import { describe, expect, it } from "@effect/vitest";
import { redactPreview, SECRET_REDACTED } from "./PreviewRedactor.ts";

describe("preview credential redaction", () => {
  it.each([
    "GOCSPX-fakeOnly_0123456789abCDef",
    "sk-fakeOnly0123456789abcdef",
    "xoxb-1234567890-fakeOnly",
    "ghp_fakeOnly0123456789abcdef",
    "AIzaFakeOnly0123456789abcdefghijklmno",
    "eyJfakeHeader.eyJfakePayload.fakeSignature",
    "aZ9_xT4-kB7_pQ2-vN6_jH8_mR3",
    "9b1c3e5f7a2d4b6c8e0f123456789abc",
  ])("masks fake credential pattern %# in every DOM output shape", (secret) => {
    const output = redactPreview({
      accessibilityTree: `- button "Copy client secret ${secret}"`,
      elements: [{ role: "button", name: `Copy ${secret}` }],
      value: [{ "aria-label": `Copy ${secret}` }],
      changes: { added: [{ name: secret }] },
      [secret]: "key also redacted",
    });
    expect(JSON.stringify(output).includes(secret)).toBe(false);
    expect(JSON.stringify(output)).toContain(SECRET_REDACTED);
  });
  it("masks plain password values, even when returned as an unlabelled string", () => {
    expect(redactPreview("copy short-pass", ["short-pass"])).toBe(`copy ${SECRET_REDACTED}`);
    expect(redactPreview({ type: "password", value: "tiny" }).value).toBe(SECRET_REDACTED);
    expect(redactPreview({ password: "tiny" }).password).toBe(SECRET_REDACTED);
  });
  it("keeps normal text, refs and image payloads useful", () => {
    const input = {
      ref: "t3-abc12345-12-e3",
      tabId: "bb31fd14-1fd2-4a40-b68d-83778ab572d1",
      name: "Google Workspace",
      notice:
        "Retry preview_open with tabId=tab_a_bb31fd14-1fd2-4a40-b68d-83778ab572d1; automationConnected=true",
      value: "normal form text",
      screenshot: { data: "aZ9_xT4-kB7_pQ2-vN6_jH8_mR3" },
    };
    expect(redactPreview(input)).toEqual(input);
  });
});
