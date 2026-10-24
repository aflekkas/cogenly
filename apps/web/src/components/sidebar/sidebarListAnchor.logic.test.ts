import { describe, expect, it } from "vite-plus/test";

import { restoredScrollTop } from "./sidebarListAnchor.logic";

// 1000px of rows in a 400px viewport: scrollTop runs 0..600.
const box = { scrollHeight: 1000, clientHeight: 400 };

describe("restoredScrollTop", () => {
  it("opens a list never seen before on its first rows", () => {
    expect(restoredScrollTop(undefined, box)).toBe(0);
  });

  it("returns a list to where it was left", () => {
    expect(restoredScrollTop(450, box)).toBe(450);
  });

  it("clamps to the content the list has now", () => {
    expect(restoredScrollTop(5000, box)).toBe(600);
    expect(restoredScrollTop(450, { scrollHeight: 200, clientHeight: 400 })).toBe(0);
  });
});
