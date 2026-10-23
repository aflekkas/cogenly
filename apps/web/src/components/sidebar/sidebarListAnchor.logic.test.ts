import { describe, expect, it } from "vite-plus/test";

import { offsetFromEdge, scrollTopForOffset } from "./sidebarListAnchor.logic";

// 1000px of rows in a 400px viewport: scrollTop runs 0..600.
const box = { scrollHeight: 1000, clientHeight: 400 };

describe("offsetFromEdge", () => {
  it("measures a bottom-anchored list from its last rows", () => {
    expect(offsetFromEdge("bottom", { ...box, scrollTop: 600 })).toBe(0);
    expect(offsetFromEdge("bottom", { ...box, scrollTop: 450 })).toBe(150);
  });

  it("measures a top-anchored list from its first rows", () => {
    expect(offsetFromEdge("top", { ...box, scrollTop: 450 })).toBe(450);
  });

  it("reads a list that fits as against both edges", () => {
    const fits = { scrollHeight: 300, clientHeight: 400, scrollTop: 0 };
    expect(offsetFromEdge("bottom", fits)).toBe(0);
    expect(offsetFromEdge("top", fits)).toBe(0);
  });
});

describe("scrollTopForOffset", () => {
  it("opens a new bottom-anchored list on its last rows", () => {
    expect(scrollTopForOffset("bottom", 0, box)).toBe(600);
  });

  it("keeps the rows on screen still when a page lands above them", () => {
    const before = offsetFromEdge("bottom", { ...box, scrollTop: 450 });
    // 300px of older rows land on top; the same rows stay in view.
    expect(scrollTopForOffset("bottom", before, { ...box, scrollHeight: 1300 })).toBe(750);
  });

  it("clamps to the content", () => {
    expect(scrollTopForOffset("bottom", 5000, box)).toBe(0);
    expect(scrollTopForOffset("top", 5000, box)).toBe(600);
    expect(scrollTopForOffset("bottom", 0, { scrollHeight: 200, clientHeight: 400 })).toBe(0);
  });
});
