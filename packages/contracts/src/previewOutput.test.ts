import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  PreviewAutomationSnapshotInput,
  PreviewAutomationSnapshotResult,
  PreviewAutomationClickInput,
  PreviewAutomationExtractInput,
} from "./previewAutomation.ts";

const decodeSnapshot = Schema.decodeSync(PreviewAutomationSnapshotInput);
const decodeClick = Schema.decodeSync(PreviewAutomationClickInput);
const decodeExtract = Schema.decodeSync(PreviewAutomationExtractInput);
const decodeUnknownSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshotInput);

describe("browser output contracts", () => {
  const encode = Schema.encodeSync(PreviewAutomationSnapshotResult);
  const screenshot = {
    mimeType: "image/jpeg" as const,
    data: "aW1hZ2U=",
    width: 1280,
    height: 800,
  };
  it("preserves compact images and capture errors across the tool encoding boundary", () => {
    const compact = {
      url: "https://example.com",
      title: "Form",
      elements: [{ ref: "e1", role: "button", name: "Save" }],
      screenshot,
    };
    expect(encode(compact)).toEqual(compact);
    expect(
      encode({ ...compact, screenshot: undefined, screenshotError: "Capture failed" }),
    ).toMatchObject({ screenshotError: "Capture failed", elements: compact.elements });
  });
  it("preserves the full tree and diagnostics when full output is requested", () => {
    const full = {
      url: "https://example.com",
      title: "Form",
      loading: false,
      visibleText: "Save",
      interactiveElements: [],
      accessibilityTree: '- button "Save" [ref=e1]',
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    };
    expect(encode(full)).toEqual(full);
  });
  it("accepts legacy inputs and validates per-call output, scope and extraction bounds", () => {
    expect(decodeSnapshot({ includeImage: true, save: true })).toEqual({
      includeImage: true,
      save: true,
    });
    expect(decodeClick({ selector: "button", output: "none" })).toMatchObject({ output: "none" });
    expect(
      decodeSnapshot({
        output: "compact",
        scope: "aria-ref=e1",
        viewportOnly: false,
      }),
    ).toMatchObject({ viewportOnly: false });
    expect(() => decodeUnknownSnapshot({ output: "html" })).toThrow();
    expect(() => decodeExtract({ selector: "a", limit: 101 })).toThrow();
  });
});
