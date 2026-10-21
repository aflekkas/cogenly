import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PickedElementPayloadSchema } from "./ipc.ts";
import {
  PreviewPickCommitInput,
  PreviewPickCommitRegionInput,
  PreviewPickError,
  PreviewPickHitTestInput,
  PreviewPickHover,
  PreviewPickResult,
  PreviewStreamCapabilities,
  PreviewStreamPickInput,
} from "./preview.ts";

const decodeHitTest = Schema.decodeUnknownSync(PreviewPickHitTestInput);
const decodeCommit = Schema.decodeUnknownSync(PreviewPickCommitInput);
const decodeRegion = Schema.decodeUnknownSync(PreviewPickCommitRegionInput);
const decodePickInput = Schema.decodeUnknownSync(PreviewStreamPickInput);
const decodeHover = Schema.decodeUnknownSync(PreviewPickHover);
const decodeResult = Schema.decodeUnknownSync(PreviewPickResult);
const decodeError = Schema.decodeUnknownSync(PreviewPickError);
const decodeCapabilities = Schema.decodeUnknownSync(PreviewStreamCapabilities);
const decodeElement = Schema.decodeUnknownSync(PickedElementPayloadSchema);

describe("PreviewStreamPickInput", () => {
  it("decodes each pick message", () => {
    expect(decodePickInput({ type: "pickHitTest", x: 10, y: 20 })).toEqual({
      type: "pickHitTest",
      x: 10,
      y: 20,
    });
    expect(decodePickInput({ type: "pickCommit", x: 1.5, y: 2.5 })).toEqual({
      type: "pickCommit",
      x: 1.5,
      y: 2.5,
    });
    expect(decodeRegion({ type: "pickCommitRegion", x: 0, y: 0, width: 100, height: 40 })).toEqual({
      type: "pickCommitRegion",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
    });
  });

  it("rejects non-finite coordinates", () => {
    expect(() => decodeHitTest({ type: "pickHitTest", x: Number.NaN, y: 0 })).toThrow();
    expect(() =>
      decodeHitTest({ type: "pickHitTest", x: 0, y: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() => decodeCommit({ type: "pickCommit", x: "10", y: 0 })).toThrow();
  });

  it("rejects unknown message types", () => {
    expect(() => decodePickInput({ type: "mouse", x: 0, y: 0 })).toThrow();
    expect(() => decodePickInput({ type: "pickHover", box: null, label: null })).toThrow();
    expect(() => decodePickInput(null)).toThrow();
  });
});

describe("PreviewPickHover", () => {
  it("decodes a hit and a miss", () => {
    expect(
      decodeHover({
        type: "pickHover",
        box: { x: 10, y: 20, width: 100, height: 40 },
        label: 'button "Buy It Now"',
      }),
    ).toEqual({
      type: "pickHover",
      box: { x: 10, y: 20, width: 100, height: 40 },
      label: 'button "Buy It Now"',
    });
    expect(decodeHover({ type: "pickHover", box: null, label: null })).toEqual({
      type: "pickHover",
      box: null,
      label: null,
    });
  });

  it("rejects malformed boxes", () => {
    expect(() =>
      decodeHover({ type: "pickHover", box: { x: 0, y: 0, width: "wide" }, label: null }),
    ).toThrow();
  });
});

describe("PreviewPickResult", () => {
  const annotation = {
    id: "annotation_1",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    comment: "",
    elements: [
      {
        id: "element_1",
        element: {
          pageUrl: "https://example.com/",
          pageTitle: "Example",
          tagName: "button",
          selector: "button",
          htmlPreview: "<button>Buy</button>",
          componentName: null,
          source: null,
          stack: [],
          styles: "",
          pickedAt: "2026-10-21T00:00:00.000Z",
          role: "button",
          accessibleName: "Buy",
        },
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };

  it("decodes a full annotation result", () => {
    expect(decodeResult({ type: "pickResult", annotation })).toEqual({
      type: "pickResult",
      annotation,
    });
  });

  it("rejects results without an annotation", () => {
    expect(() => decodeResult({ type: "pickResult" })).toThrow();
    expect(() => decodeError({ type: "pickError", message: 42 })).toThrow();
  });
});

describe("PreviewStreamCapabilities", () => {
  it("treats every flag as optional for version skew", () => {
    expect(decodeCapabilities({})).toEqual({});
    expect(decodeCapabilities({ pick: true })).toEqual({ pick: true });
    expect(() => decodeCapabilities({ pick: "yes" })).toThrow();
  });
});

describe("PickedElementPayloadSchema pick extensions", () => {
  const base = {
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    tagName: "button",
    selector: "button",
    htmlPreview: "<button>Buy</button>",
    componentName: null,
    source: null,
    stack: [],
    styles: "",
    pickedAt: "2026-10-21T00:00:00.000Z",
  };

  it("accepts desktop payloads without the new fields", () => {
    expect(decodeElement(base)).toEqual(base);
  });

  it("accepts server payloads with the new fields", () => {
    expect(
      decodeElement({
        ...base,
        role: "button",
        accessibleName: "Buy",
        attributes: { id: "buy", "aria-pressed": "false" },
        domPath: "body > main > button:nth-of-type(1)",
        textContent: "Buy",
      }),
    ).toEqual({
      ...base,
      role: "button",
      accessibleName: "Buy",
      attributes: { id: "buy", "aria-pressed": "false" },
      domPath: "body > main > button:nth-of-type(1)",
      textContent: "Buy",
    });
  });

  it("rejects mistyped extensions", () => {
    expect(() => decodeElement({ ...base, role: 42 })).toThrow();
    expect(() => decodeElement({ ...base, attributes: { id: 42 } })).toThrow();
    expect(() => decodeElement({ ...base, attributes: ["id"] })).toThrow();
    expect(() => decodeElement({ ...base, textContent: null })).toThrow();
  });
});
