import { describe, expect, it } from "vite-plus/test";

import { nextPanelHeight } from "./animatedPanelHeight.logic";

describe("nextPanelHeight", () => {
  it("takes the first measurement without animating", () => {
    expect(nextPanelHeight(null, 180)).toEqual({ height: 180, animate: false });
  });

  it("animates every later change", () => {
    const first = nextPanelHeight(null, 180);
    const grown = nextPanelHeight(first, 288);
    expect(grown).toEqual({ height: 288, animate: true });
    expect(nextPanelHeight(grown, 96)).toEqual({ height: 96, animate: true });
  });

  it("keeps the same value for an unchanged size", () => {
    const first = nextPanelHeight(null, 180.5);
    expect(nextPanelHeight(first, 180.5)).toBe(first);
  });

  it("resets on a zero size so the next open does not grow from 0", () => {
    const open = nextPanelHeight(null, 180);
    const hidden = nextPanelHeight(open, 0);
    expect(hidden).toBeNull();
    expect(nextPanelHeight(hidden, 240)).toEqual({ height: 240, animate: false });
  });
});
