import { describe, expect, it } from "vite-plus/test";

import { colorBlend, hexToRgb, rgbToHex } from "./accentColors.ts";

const lum = ([r, g, b]: readonly [number, number, number]) => 0.3 * r + 0.59 * g + 0.11 * b;

describe("colorBlend", () => {
  it("keeps white white, so the mark's glyph survives a tint", () => {
    expect(colorBlend([255, 255, 255], hexToRgb("#4c8dff"))).toEqual([255, 255, 255]);
  });

  it("keeps the backdrop's lightness and takes the tint's hue", () => {
    const ember = hexToRgb("#f3592a");
    const tinted = colorBlend(ember, hexToRgb("#4c8dff"));
    expect(Math.abs(lum(tinted) - lum(ember))).toBeLessThan(1.5);
    // Blue now dominates where red did.
    expect(tinted[2]).toBeGreaterThan(tinted[0]);
  });

  it("clips an out-of-gamut result toward its lightness, as the spec's ClipColor does", () => {
    // SetLum(#4c8dff, Lum(#ff8040)) overshoots blue past 255; ClipColor
    // scales it back around the luminance: (113, 165, 255).
    expect(colorBlend(hexToRgb("#ff8040"), hexToRgb("#4c8dff"))).toEqual([113, 165, 255]);
  });
});

describe("hex conversion", () => {
  it("round-trips", () => {
    expect(rgbToHex(hexToRgb("#1fb3a5"))).toBe("#1fb3a5");
  });
});
