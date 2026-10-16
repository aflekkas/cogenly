import { describe, expect, it } from "vite-plus/test";

import { resolveVerticalTabIndex } from "./navRail.logic";

describe("resolveVerticalTabIndex", () => {
  it("moves down and up, wrapping at the ends", () => {
    expect(resolveVerticalTabIndex("ArrowDown", 0, 3)).toBe(1);
    expect(resolveVerticalTabIndex("ArrowDown", 2, 3)).toBe(0);
    expect(resolveVerticalTabIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("jumps to the first and last tab", () => {
    expect(resolveVerticalTabIndex("Home", 2, 3)).toBe(0);
    expect(resolveVerticalTabIndex("End", 0, 3)).toBe(2);
  });

  it("ignores other keys, including horizontal arrows", () => {
    expect(resolveVerticalTabIndex("ArrowRight", 0, 3)).toBeNull();
    expect(resolveVerticalTabIndex("Enter", 0, 3)).toBeNull();
  });
});
