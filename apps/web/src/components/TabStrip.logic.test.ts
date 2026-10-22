import { describe, expect, it } from "vite-plus/test";

import { interleaveLeavingTabs, tabSetChanges, tabStripFocusIndex } from "./TabStrip.logic";

describe("tabStripFocusIndex", () => {
  it("wraps arrows and jumps to the ends", () => {
    expect(tabStripFocusIndex("ArrowRight", 2, 3)).toBe(0);
    expect(tabStripFocusIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(tabStripFocusIndex("ArrowRight", 0, 3)).toBe(1);
    expect(tabStripFocusIndex("Home", 2, 3)).toBe(0);
    expect(tabStripFocusIndex("End", 0, 3)).toBe(2);
  });

  it("leaves other keys and empty strips alone", () => {
    expect(tabStripFocusIndex("Enter", 0, 3)).toBeNull();
    expect(tabStripFocusIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("tabSetChanges", () => {
  it("names arrivals and each departure's left neighbour", () => {
    expect(tabSetChanges(["a", "b", "c"], ["a", "c", "d"])).toEqual({
      arrivals: ["d"],
      departures: [{ id: "b", afterId: "a" }],
    });
    expect(tabSetChanges(["a", "b"], ["b"]).departures).toEqual([{ id: "a", afterId: null }]);
  });
});

describe("interleaveLeavingTabs", () => {
  const order = (entries: ReturnType<typeof interleaveLeavingTabs<{ id: string }>>) =>
    entries.map((entry) => (entry.kind === "tab" ? entry.item.id : `-${entry.slot.id}`));

  it("folds a closed tab shut in its old place", () => {
    const entries = interleaveLeavingTabs(
      [{ id: "a" }, { id: "c" }],
      [{ id: "b", afterId: "a", width: 80 }],
    );
    expect(order(entries)).toEqual(["a", "-b", "c"]);
    expect(entries.flatMap((entry) => (entry.kind === "tab" ? [entry.index] : []))).toEqual([0, 1]);
  });

  it("keeps a run of closed neighbours together and in order", () => {
    const entries = interleaveLeavingTabs(
      [{ id: "a" }, { id: "d" }],
      [
        { id: "c", afterId: "b", width: 80 },
        { id: "b", afterId: "a", width: 80 },
      ],
    );
    expect(order(entries)).toEqual(["a", "-b", "-c", "d"]);
  });

  it("puts a closed first tab first, and an orphaned slot last", () => {
    const entries = interleaveLeavingTabs(
      [{ id: "b" }],
      [
        { id: "a", afterId: null, width: 80 },
        { id: "z", afterId: "gone", width: 80 },
      ],
    );
    expect(order(entries)).toEqual(["-a", "b", "-z"]);
  });
});
