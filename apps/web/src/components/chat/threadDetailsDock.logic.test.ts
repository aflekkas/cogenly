import { describe, expect, it } from "vite-plus/test";

import { canDockThreadDetails } from "./threadDetailsDock.logic";

const minChatWidth = 640;

describe("canDockThreadDetails", () => {
  it("docks beside a wide chat pane", () => {
    expect(canDockThreadDetails({ canvasWidth: 1511, minChatWidth })).toBe(true);
  });

  it("falls back to the popover when chat would drop below its minimum width", () => {
    // 1100 - 12 - 324 - 32 - 48 = 684 fits; 1040 leaves 624.
    expect(canDockThreadDetails({ canvasWidth: 1100, minChatWidth })).toBe(true);
    expect(canDockThreadDetails({ canvasWidth: 1040, minChatWidth })).toBe(false);
  });

  it("docks when the remaining canvas beside a right panel has room", () => {
    expect(canDockThreadDetails({ canvasWidth: 1200, minChatWidth })).toBe(true);
  });

  it("waits for the canvas's first measure", () => {
    expect(canDockThreadDetails({ canvasWidth: 0, minChatWidth })).toBe(false);
  });
});
