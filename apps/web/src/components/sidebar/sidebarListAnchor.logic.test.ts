import { describe, expect, it } from "vite-plus/test";

import { offsetFromEdge, scrollTopForOffset, sidebarListEdge } from "./sidebarListAnchor.logic";

// 1000px of rows in a 400px viewport: scrollTop runs 0..600.
const box = { scrollHeight: 1000, clientHeight: 400 };

describe("sidebarListEdge", () => {
  it("reads every list down from the dock in the top layout", () => {
    for (const mode of ["tasks", "agents", "chats"]) {
      expect(sidebarListEdge({ layout: "top", searching: false, mode, shelf: null })).toBe("top");
    }
    expect(sidebarListEdge({ layout: "top", searching: true, mode: "tasks", shelf: null })).toBe(
      "top",
    );
  });

  it("anchors Work's active lists and Agents to the dock in the bottom layout", () => {
    const bottom = (mode: string, shelf: string | null) =>
      sidebarListEdge({ layout: "bottom", searching: false, mode, shelf });
    expect(bottom("tasks", null)).toBe("bottom");
    expect(bottom("tasks", "attention")).toBe("bottom");
    expect(bottom("agents", null)).toBe("bottom");
  });

  it("opens Settings' sections on the ones by the dock, in the bottom layout only", () => {
    const settings = (layout: "top" | "bottom") =>
      sidebarListEdge({ layout, searching: false, mode: "settings", shelf: null });
    expect(settings("bottom")).toBe("bottom");
    expect(settings("top")).toBe("top");
  });

  it("runs Settled, Snoozed, Chats and search from the top in the bottom layout", () => {
    const bottom = (mode: string, shelf: string | null, searching = false) =>
      sidebarListEdge({ layout: "bottom", searching, mode, shelf });
    expect(bottom("tasks", "settled")).toBe("top");
    expect(bottom("tasks", "snoozed")).toBe("top");
    expect(bottom("chats", null)).toBe("top");
    expect(bottom("tasks", null, true)).toBe("top");
    expect(bottom("settings", null, true)).toBe("top");
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
