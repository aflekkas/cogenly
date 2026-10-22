import { describe, expect, it } from "vite-plus/test";

import { drawSwatchBitmap, parseHexColor } from "./menuSwatch.ts";

describe("menu swatches", () => {
  it("only draws plain hex colors", () => {
    expect(parseHexColor("#2b7fff")).toEqual({ r: 0x2b, g: 0x7f, b: 0xff });
    expect(parseHexColor("var(--color-blue-500)")).toBeNull();
    expect(parseHexColor(undefined)).toBeNull();
  });

  it("draws an opaque disc in BGRA with transparent corners", () => {
    const { buffer, size } = drawSwatchBitmap({ r: 0x2b, g: 0x7f, b: 0xff }, 12, 2);
    expect(size).toBe(24);
    expect(buffer.length).toBe(24 * 24 * 4);
    const center = (12 * size + 12) * 4;
    expect([...buffer.subarray(center, center + 4)]).toEqual([0xff, 0x7f, 0x2b, 0xff]);
    expect(buffer[3]).toBe(0);
  });
});
