import { describe, expect, it } from "vite-plus/test";

import {
  buildPickElementAnnotation,
  buildPickHoverLabel,
  buildPickRegionAnnotation,
  buildPickedElementPayload,
  normalizePickBox,
  normalizePickPoint,
  parsePngDimensions,
  pickCropRect,
  PICK_CROP_MAX_HEIGHT,
  PICK_CROP_MAX_WIDTH,
  PICK_HTML_PREVIEW_MAX_CHARS,
  PICK_STYLES_MAX_CHARS,
  sanitizePickAttributes,
  truncatePickText,
} from "./previewPick.ts";

/** First 33 bytes of a PNG with the given IHDR size, base64-encoded. */
const pngBytes = (width: number, height: number): string => {
  const bytes = Buffer.alloc(33, 0);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
};

describe("truncatePickText", () => {
  it("normalizes newlines and caps with an ellipsis", () => {
    expect(truncatePickText("a\r\nb", 100)).toBe("a\nb");
    expect(truncatePickText("\n\npadded\n\n", 100)).toBe("padded");
    expect(truncatePickText("abcdef", 5)).toBe("abcd…");
    expect(truncatePickText("abcde", 5)).toBe("abcde");
  });
});

describe("normalizePickPoint", () => {
  it("accepts finite points and rejects the rest", () => {
    expect(normalizePickPoint({ x: 1.5, y: 2 })).toEqual({ x: 1.5, y: 2 });
    expect(normalizePickPoint({ x: Number.NaN, y: 0 })).toBeNull();
    expect(normalizePickPoint({ x: 0, y: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizePickPoint({ x: "1", y: 0 })).toBeNull();
    expect(normalizePickPoint(null)).toBeNull();
  });
});

describe("normalizePickBox", () => {
  it("rejects negative sizes", () => {
    expect(normalizePickBox({ x: 0, y: 0, width: 10, height: 5 })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 5,
    });
    expect(normalizePickBox({ x: 0, y: 0, width: -1, height: 5 })).toBeNull();
    expect(normalizePickBox({ x: 0, y: 0, width: 5 })).toBeNull();
  });
});

describe("pickCropRect", () => {
  const viewport = { width: 1280, height: 800 };

  it("pads and rounds outward", () => {
    expect(pickCropRect({ x: 10.7, y: 20.2, width: 100, height: 40 }, viewport, 12)).toEqual({
      x: 0,
      y: 8,
      width: 100 + 24,
      height: 40 + 24,
    });
  });

  it("clamps into the viewport", () => {
    expect(pickCropRect({ x: -50, y: -50, width: 100, height: 100 }, viewport, 12)).toEqual({
      x: 0,
      y: 0,
      width: 100 + 24,
      height: 100 + 24,
    });
    expect(pickCropRect({ x: 1200, y: 700, width: 500, height: 500 }, viewport, 0)).toEqual({
      x: 1200,
      y: 700,
      width: 80,
      height: 100,
    });
  });

  it("caps huge elements", () => {
    expect(pickCropRect({ x: 0, y: 0, width: 5000, height: 4000 }, viewport, 0)).toEqual({
      x: 0,
      y: 0,
      width: Math.min(1280, PICK_CROP_MAX_WIDTH),
      height: Math.min(800, PICK_CROP_MAX_HEIGHT),
    });
  });

  it("returns null when nothing usable remains", () => {
    expect(pickCropRect({ x: 2000, y: 0, width: 10, height: 10 }, viewport, 0)).toBeNull();
    expect(pickCropRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("parsePngDimensions", () => {
  it("reads the IHDR size", () => {
    expect(parsePngDimensions(pngBytes(320, 240))).toEqual({ x: 0, y: 0, width: 320, height: 240 });
  });

  it("rejects non-PNG bytes", () => {
    expect(parsePngDimensions("")).toBeNull();
    expect(parsePngDimensions("not-base64!!!")).toBeNull();
    expect(parsePngDimensions(Buffer.alloc(40, 0).toString("base64"))).toBeNull();
  });
});

describe("buildPickHoverLabel", () => {
  it("names tag, role, and accessible name", () => {
    expect(buildPickHoverLabel({ tagName: "button", accessibleName: "Buy It Now" })).toBe(
      'button "Buy It Now"',
    );
    expect(buildPickHoverLabel({ tagName: "span", role: "link", accessibleName: "More" })).toBe(
      'link (span) "More"',
    );
  });

  it("falls back to id, class, then tag", () => {
    expect(buildPickHoverLabel({ tagName: "div", id: "hero" })).toBe("div #hero");
    expect(buildPickHoverLabel({ tagName: "div", className: "card muted" })).toBe("div .card");
    expect(buildPickHoverLabel({ tagName: "DIV" })).toBe("div");
    expect(buildPickHoverLabel({ tagName: "  " })).toBeNull();
  });
});

describe("sanitizePickAttributes", () => {
  it("drops non-strings and caps count", () => {
    expect(sanitizePickAttributes({ id: "buy", count: 42, empty: "  " })).toEqual({ id: "buy" });
    expect(sanitizePickAttributes({})).toBeUndefined();
    expect(sanitizePickAttributes(null)).toBeUndefined();
    expect(sanitizePickAttributes([{ id: "x" }])).toBeUndefined();
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`data-${index}`, "v"]),
    );
    expect(Object.keys(sanitizePickAttributes(many) ?? {}).length).toBe(24);
  });

  it("truncates long values", () => {
    const attributes = sanitizePickAttributes({ href: `https://example.com/${"a".repeat(600)}` });
    expect(attributes?.["href"]?.length).toBe(500);
    expect(attributes?.["href"]?.endsWith("…")).toBe(true);
  });
});

describe("buildPickedElementPayload", () => {
  const meta = {
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    pickedAt: "2026-10-21T00:00:00.000Z",
  };

  it("sanitizes a raw capture", () => {
    const element = buildPickedElementPayload(
      {
        tagName: "BUTTON",
        selector: "  button.buy  ",
        htmlPreview: `<button>${"x".repeat(5000)}</button>`,
        textContent: "  Buy now  ",
        role: "button",
        accessibleName: "Buy now",
        attributes: { id: "buy", count: 42 },
        domPath: "body > button",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        styles: `color: red;\n${"y".repeat(5000)}`,
      },
      meta,
    );
    expect(element?.tagName).toBe("button");
    expect(element?.selector).toBe("button.buy");
    expect(element?.htmlPreview.length).toBe(PICK_HTML_PREVIEW_MAX_CHARS);
    expect(element?.styles.length).toBe(PICK_STYLES_MAX_CHARS);
    expect(element?.textContent).toBe("Buy now");
    expect(element?.attributes).toEqual({ id: "buy" });
    expect(element?.componentName).toBeNull();
    expect(element?.stack).toEqual([]);
  });

  it("omits empty extensions and rejects tagless captures", () => {
    const element = buildPickedElementPayload(
      {
        tagName: "div",
        selector: null,
        htmlPreview: "",
        textContent: "   ",
        role: "",
        accessibleName: null,
        attributes: {},
        domPath: null,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        styles: "",
      },
      meta,
    );
    expect(element).toMatchObject({ tagName: "div", selector: null });
    expect(element).not.toHaveProperty("role");
    expect(element).not.toHaveProperty("accessibleName");
    expect(element).not.toHaveProperty("attributes");
    expect(element).not.toHaveProperty("domPath");
    expect(element).not.toHaveProperty("textContent");
    expect(buildPickedElementPayload({ tagName: "  " } as never, meta)).toBeNull();
    expect(
      buildPickedElementPayload({ tagName: "div" } as never, { ...meta, pageUrl: "  " }),
    ).toBeNull();
  });
});

describe("pick annotation builders", () => {
  const meta = {
    id: "annotation_1",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
    createdAt: "2026-10-21T00:00:00.000Z",
    screenshot: null,
  };

  it("builds an element annotation", () => {
    const annotation = buildPickElementAnnotation(meta, {
      id: "element_1",
      element: buildPickedElementPayload({ tagName: "button" } as never, {
        pageUrl: meta.pageUrl,
        pageTitle: meta.pageTitle,
        pickedAt: meta.createdAt,
      })!,
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(annotation.elements.length).toBe(1);
    expect(annotation.regions).toEqual([]);
    expect(annotation.comment).toBe("");
  });

  it("builds a region annotation with no element", () => {
    const annotation = buildPickRegionAnnotation(meta, {
      id: "region_1",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(annotation.elements).toEqual([]);
    expect(annotation.regions).toEqual([
      { id: "region_1", rect: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
  });
});
