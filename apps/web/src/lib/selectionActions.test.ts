import { describe, expect, it } from "vite-plus/test";

import { resolveSelectionPillPosition } from "./selectionActions";

const base = {
  column: { left: 100, right: 700 },
  bounds: { top: 0, bottom: 600 },
  size: { width: 60, height: 24 },
  viewport: { width: 1000, height: 800 },
};
const line = (left: number, right: number, top: number) => ({
  left,
  right,
  top,
  bottom: top + 20,
});

describe("resolveSelectionPillPosition", () => {
  it("centers the pill under the end of the selection", () => {
    expect(
      resolveSelectionPillPosition({ ...base, lines: [line(150, 650, 100), line(100, 300, 120)] }),
    ).toEqual({ x: 270, y: 146 });
  });

  it("skips the zero-width rect a paragraph selection ends on", () => {
    expect(
      resolveSelectionPillPosition({ ...base, lines: [line(150, 400, 100), line(100, 100, 120)] }),
    ).toEqual({ x: 370, y: 126 });
  });

  it("flips above the start of the selection near the bottom of the viewport", () => {
    expect(
      resolveSelectionPillPosition({ ...base, lines: [line(200, 650, 540), line(100, 400, 560)] }),
    ).toEqual({ x: 170, y: 510 });
  });

  it("stays inside the message column", () => {
    expect(resolveSelectionPillPosition({ ...base, lines: [line(660, 700, 100)] })?.x).toBe(640);
    expect(resolveSelectionPillPosition({ ...base, lines: [line(100, 110, 100)] })?.x).toBe(100);
  });

  it("returns null without a visible line", () => {
    expect(resolveSelectionPillPosition({ ...base, lines: [line(100, 100, 100)] })).toBeNull();
  });
});
