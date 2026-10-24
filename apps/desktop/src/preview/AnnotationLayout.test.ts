import { describe, expect, it } from "vite-plus/test";

import { annotationBoxInsets } from "./AnnotationLayout.ts";

const viewport = { width: 800, height: 600 };

describe("annotationBoxInsets", () => {
  it("insets a full-page frame equally on every edge", () => {
    expect(annotationBoxInsets({ x: 0, y: 0, ...viewport }, viewport)).toBe("2px 2px 2px 2px");
  });

  it("clips an overflowing target to the visible viewport", () => {
    expect(annotationBoxInsets({ x: -40, y: -20, width: 1200, height: 1000 }, viewport)).toBe(
      "2px 2px 2px 2px",
    );
  });

  it("preserves the bounds of an interior target", () => {
    expect(annotationBoxInsets({ x: 100, y: 80, width: 200, height: 120 }, viewport)).toBe(
      "80px 500px 400px 100px",
    );
  });

  it("uses the current viewport after a resize", () => {
    expect(
      annotationBoxInsets({ x: 100, y: 80, width: 600, height: 400 }, { width: 400, height: 300 }),
    ).toBe("80px 2px 2px 100px");
  });

  it("hides empty and offscreen targets", () => {
    expect(annotationBoxInsets({ x: 900, y: 80, width: 20, height: 20 }, viewport)).toBeNull();
    expect(annotationBoxInsets({ x: 50, y: 50, width: 0, height: 20 }, viewport)).toBeNull();
    expect(
      annotationBoxInsets({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }),
    ).toBeNull();
  });
});
