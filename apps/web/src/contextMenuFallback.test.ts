import { describe, expect, it } from "vite-plus/test";

import { resolveMenuPosition, type MenuPlacement } from "./contextMenuFallback";

const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 300 };

function atCursor(x: number, y: number): MenuPlacement {
  return { left: x, top: y, flippedLeft: (width) => x - width, flippedTop: (height) => y - height };
}

describe("resolveMenuPosition", () => {
  it("opens at the cursor when the menu fits", () => {
    expect(resolveMenuPosition(atCursor(100, 100), size, viewport)).toEqual({
      left: 100,
      top: 100,
    });
  });

  it("opens above the cursor when there is no room below", () => {
    expect(resolveMenuPosition(atCursor(100, 700), size, viewport)).toEqual({
      left: 100,
      top: 400,
    });
  });

  it("opens left of the cursor when there is no room to the right", () => {
    expect(resolveMenuPosition(atCursor(900, 100), size, viewport).left).toBe(700);
  });

  it("keeps a margin from the edges when neither side fits", () => {
    expect(resolveMenuPosition(atCursor(100, 200), { width: 200, height: 790 }, viewport)).toEqual({
      left: 100,
      top: 8,
    });
  });

  it("shifts inward, clear of the bottom edge, when neither side fits", () => {
    // Above the cursor it would not fit either, so it stays below and shifts up.
    expect(resolveMenuPosition(atCursor(100, 250), { width: 200, height: 600 }, viewport).top).toBe(
      192,
    );
  });
});
