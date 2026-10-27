import { describe, expect, it } from "vite-plus/test";

import {
  drawFromDock,
  drawGroupsFromDock,
  offsetFromEdge,
  scrollTopForOffset,
  stepSearchResultIndex,
} from "./sidebarListAnchor.logic";

// 1000px of rows in a 400px viewport: scrollTop runs 0..600.
const box = { scrollHeight: 1000, clientHeight: 400 };

describe("drawFromDock", () => {
  // Snoozed, soonest wake first.
  const snoozed = ["in 1h", "tomorrow", "next week"];

  it("draws the most relevant item first, under the dock, in the top layout", () => {
    expect(drawFromDock(snoozed, "top")).toEqual(["in 1h", "tomorrow", "next week"]);
  });

  it("draws the most relevant item last, over the dock, in the bottom layout", () => {
    expect(drawFromDock(snoozed, "bottom")).toEqual(["next week", "tomorrow", "in 1h"]);
    expect(snoozed).toEqual(["in 1h", "tomorrow", "next week"]);
  });
});

describe("drawGroupsFromDock", () => {
  // Chats, ranked from the dock: the drafts, then Pinned, then Today, newest first.
  const groups = [
    { header: null, rows: ["draft"] },
    { header: "Pinned", rows: ["pin a", "pin b"] },
    { header: "Today", rows: ["newest", "older"] },
  ];

  it("reads groups and rows down from the dock in the top layout", () => {
    expect(drawGroupsFromDock(groups, "top")).toEqual([
      "draft",
      "Pinned",
      "pin a",
      "pin b",
      "Today",
      "newest",
      "older",
    ]);
  });

  it("stacks them up to the dock in the bottom layout, each heading above its rows", () => {
    expect(drawGroupsFromDock(groups, "bottom")).toEqual([
      "Today",
      "older",
      "newest",
      "Pinned",
      "pin b",
      "pin a",
      "draft",
    ]);
  });
});

describe("stepSearchResultIndex", () => {
  it("moves down the ranking with ArrowDown when results read down from the input", () => {
    expect(stepSearchResultIndex("ArrowDown", 0, 3, "top")).toBe(1);
    expect(stepSearchResultIndex("ArrowUp", 0, 3, "top")).toBe(2);
  });

  it("moves up, away from the input, to lower matches when results stack above it", () => {
    expect(stepSearchResultIndex("ArrowUp", 0, 3, "bottom")).toBe(1);
    expect(stepSearchResultIndex("ArrowUp", 2, 3, "bottom")).toBe(0);
    expect(stepSearchResultIndex("ArrowDown", 1, 3, "bottom")).toBe(0);
    expect(stepSearchResultIndex("ArrowDown", 0, 3, "bottom")).toBe(2);
  });
});

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
  it("opens a new top-anchored list on its first rows", () => {
    expect(scrollTopForOffset("top", 0, box)).toBe(0);
  });

  it("opens a new bottom-anchored list on its last rows", () => {
    expect(scrollTopForOffset("bottom", 0, box)).toBe(600);
  });

  it("keeps a bottom-anchored list resting on its last rows pinned there as rows arrive", () => {
    expect(scrollTopForOffset("bottom", 0, { ...box, scrollHeight: 1088 })).toBe(688);
  });

  it("keeps the rows on screen still when a page lands above them", () => {
    const before = offsetFromEdge("bottom", { ...box, scrollTop: 450 });
    // 300px of older rows land on top; the same rows stay in view.
    expect(scrollTopForOffset("bottom", before, { ...box, scrollHeight: 1300 })).toBe(750);
  });

  // A settled card leaving a bottom-anchored list: the list re-pins to its
  // last rows, so on screen only the rows above the gap move (down, closing
  // it) and the rows below stay put. The sidebar's row motion measures rows on
  // screen for exactly this reason (Sidebar.motion.ts).
  it("moves only the rows above a row that leaves a bottom-anchored list", () => {
    const card = 88;
    const before = { ...box, scrollTop: 600 };
    const after = { ...box, scrollHeight: box.scrollHeight - card };
    const scrollTop = scrollTopForOffset("bottom", offsetFromEdge("bottom", before), after);
    expect(scrollTop).toBe(600 - card);
    const onScreen = (offsetTop: number, top: number) => offsetTop - top;
    // A row above the gap keeps its offset; the scroll brings it down by a card.
    expect(onScreen(400, scrollTop) - onScreen(400, before.scrollTop)).toBe(card);
    // A row below the gap loses a card of offset and the scroll matches it.
    expect(onScreen(900 - card, scrollTop) - onScreen(900, before.scrollTop)).toBe(0);
  });

  it("leaves a top-anchored list's rows above the gap still", () => {
    const card = 88;
    const before = { ...box, scrollTop: 200 };
    const after = { ...box, scrollHeight: box.scrollHeight - card };
    expect(scrollTopForOffset("top", offsetFromEdge("top", before), after)).toBe(200);
  });

  it("clamps to the content", () => {
    expect(scrollTopForOffset("bottom", 5000, box)).toBe(0);
    expect(scrollTopForOffset("top", 5000, box)).toBe(600);
    expect(scrollTopForOffset("bottom", 0, { scrollHeight: 200, clientHeight: 400 })).toBe(0);
  });
});
