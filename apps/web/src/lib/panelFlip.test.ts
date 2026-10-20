import { describe, expect, it } from "vite-plus/test";

import { resolvePanelFlipOffsets } from "./panelFlip";

const bounds = (left: number, right: number) => ({ left, right });

describe("resolvePanelFlipOffsets", () => {
  it("starts each anchor where it was drawn when the sidebar closes", () => {
    // The main pane grows 280px to the left; its right edge stays put.
    const offsets = resolvePanelFlipOffsets([
      { anchor: "start", before: bounds(336, 600), after: bounds(56, 320), parent: null },
      { anchor: "center", before: bounds(520, 1256), after: bounds(380, 1116), parent: null },
      { anchor: "end", before: bounds(1100, 1400), after: bounds(1100, 1400), parent: null },
    ]);
    expect(offsets).toEqual([280, 140, 0]);
  });

  it("measures a resized element from its anchor", () => {
    // A column that widens with the pane: its center moves half the distance.
    const [offset] = resolvePanelFlipOffsets([
      { anchor: "center", before: bounds(336, 1440), after: bounds(56, 1440), parent: null },
    ]);
    expect(offset).toBe(140);
  });

  it("plays only the difference from a moving ancestor", () => {
    const offsets = resolvePanelFlipOffsets([
      { anchor: "center", before: bounds(336, 1440), after: bounds(56, 1440), parent: null },
      // A card held to the right edge inside the column does not move on
      // screen, so it counters the column's travel.
      { anchor: "end", before: bounds(1100, 1400), after: bounds(1100, 1400), parent: 0 },
      // Content riding the column exactly needs no animation of its own.
      { anchor: "center", before: bounds(600, 900), after: bounds(460, 760), parent: 0 },
    ]);
    expect(offsets).toEqual([140, -140, 0]);
  });

  it("ignores subpixel shifts", () => {
    expect(
      resolvePanelFlipOffsets([
        { anchor: "start", before: bounds(10.3, 20), after: bounds(10, 20), parent: null },
      ]),
    ).toEqual([0]);
  });
});
