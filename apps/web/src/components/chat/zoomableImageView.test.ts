import { describe, expect, it } from "vite-plus/test";

import {
  MAX_IMAGE_SCALE,
  clampView,
  fitScale,
  fitView,
  interpolateView,
  panView,
  pannableAxes,
  toggleScale,
  zoomViewAt,
  type CanvasMetrics,
} from "./zoomableImageView";

const viewport = { width: 1000, height: 600 };
const large: CanvasMetrics = { natural: { width: 1024, height: 1024 }, viewport, pad: 40 };
const small: CanvasMetrics = { natural: { width: 64, height: 32 }, viewport, pad: 40 };

describe("fit", () => {
  it("fits a large image inside the padding on its tighter axis, centered", () => {
    expect(fitScale(large)).toBeCloseTo(520 / 1024);
    const view = fitView(large);
    const width = 1024 * view.scale;
    expect(view.y).toBeCloseTo(40);
    expect(view.x).toBeCloseTo((1000 - width) / 2);
  });

  it("never upscales a small image past 100%", () => {
    expect(fitScale(small)).toBe(1);
    expect(fitView(small)).toEqual({ scale: 1, x: (1000 - 64) / 2, y: (600 - 32) / 2 });
  });
});

describe("clamping", () => {
  it("keeps the scale between fit and 8x", () => {
    expect(clampView({ scale: 0.01, x: 0, y: 0 }, large).scale).toBeCloseTo(fitScale(large));
    expect(clampView({ scale: 100, x: 0, y: 0 }, large).scale).toBe(MAX_IMAGE_SCALE);
    expect(clampView({ scale: 100, x: 0, y: 0 }, small).scale).toBe(MAX_IMAGE_SCALE);
  });

  it("does not pan at fit", () => {
    const fitted = fitView(large);
    expect(panView(fitted, 300, -200, large)).toEqual(fitted);
    expect(pannableAxes(fitted, large)).toEqual({ x: false, y: false });
  });

  it("pans a zoomed image only until its edge meets the padding", () => {
    const zoomed = { scale: 2, x: -500, y: -500 };
    expect(pannableAxes(zoomed, large)).toEqual({ x: true, y: true });
    expect(panView(zoomed, 10_000, 10_000, large)).toEqual({ scale: 2, x: 40, y: 40 });
    expect(panView(zoomed, -10_000, -10_000, large)).toEqual({
      scale: 2,
      x: 1000 - 40 - 2048,
      y: 600 - 40 - 2048,
    });
  });

  it("centers an axis that still fits while the other pans", () => {
    const wide: CanvasMetrics = { natural: { width: 2000, height: 100 }, viewport, pad: 40 };
    const view = clampView({ scale: 1, x: -300, y: 0 }, wide);
    expect(view.x).toBe(-300);
    expect(view.y).toBe(250);
  });
});

describe("zoom around the cursor", () => {
  it("keeps the image point under the cursor fixed", () => {
    const from = { scale: 1, x: -100, y: -200 };
    const anchor = { x: 300, y: 250 };
    const to = zoomViewAt(from, 2, anchor, large);
    const before = { x: (anchor.x - from.x) / from.scale, y: (anchor.y - from.y) / from.scale };
    const after = { x: (anchor.x - to.x) / to.scale, y: (anchor.y - to.y) / to.scale };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("recenters when zooming back out to fit, wherever the cursor is", () => {
    const zoomed = zoomViewAt(fitView(large), 4, { x: 900, y: 100 }, large);
    expect(zoomViewAt(zoomed, 0.001, { x: 900, y: 100 }, large)).toEqual(fitView(large));
  });

  it("eases along the anchored path and lands exactly on the target", () => {
    const from = fitView(large);
    const anchor = { x: 500, y: 300 };
    const to = zoomViewAt(from, 2, anchor, large);
    const mid = interpolateView(from, to, 0.5, anchor, large);
    expect(mid.scale).toBeCloseTo(Math.sqrt(from.scale * to.scale));
    const imageX = (anchor.x - from.x) / from.scale;
    expect((anchor.x - mid.x) / mid.scale).toBeCloseTo(imageX);
    expect(interpolateView(from, to, 1, anchor, large)).toEqual(to);
  });
});

describe("double-click", () => {
  it("toggles between fit and 100%", () => {
    const fitted = fitView(large);
    expect(toggleScale(fitted, large)).toBe(1);
    expect(toggleScale({ ...fitted, scale: 1 }, large)).toBeCloseTo(fitScale(large));
    expect(toggleScale({ ...fitted, scale: 3 }, large)).toBe(1);
  });

  it("goes to 2x for an image already at 100% when fitted", () => {
    expect(toggleScale(fitView(small), small)).toBe(2);
    expect(toggleScale({ scale: 2, x: 0, y: 0 }, small)).toBe(1);
  });
});
