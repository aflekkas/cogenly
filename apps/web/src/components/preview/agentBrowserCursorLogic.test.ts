import { describe, expect, it } from "vite-plus/test";

import {
  agentBrowserCursorOpacity,
  composeFrames,
  containFrame,
  coverTopFrame,
  placeAgentTarget,
} from "./agentBrowserCursorLogic";

const identity = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

describe("placeAgentTarget", () => {
  it("outlines the element the cursor arrives on", () => {
    expect(
      placeAgentTarget(
        { phase: "move", x: 60, y: 30, box: { x: 10, y: 20, width: 100, height: 20 } },
        identity,
      ),
    ).toEqual({ left: 60, top: 30, outline: { left: 10, top: 20, width: 100, height: 20 } });
  });

  it("shows the click's ripple, not a second outline", () => {
    const box = { x: 10, y: 20, width: 100, height: 20 };
    expect(placeAgentTarget({ phase: "click", x: 60, y: 30, box }, identity).outline).toBeNull();
  });

  it("draws no outline for a point action or an empty box", () => {
    expect(placeAgentTarget({ phase: "move", x: 5, y: 5, box: null }, identity).outline).toBeNull();
    expect(placeAgentTarget({ phase: "move", x: 5, y: 5 }, identity).outline).toBeNull();
    expect(
      placeAgentTarget(
        { phase: "move", x: 5, y: 5, box: { x: 0, y: 0, width: 0, height: 9 } },
        identity,
      ).outline,
    ).toBeNull();
  });

  it("scales the cursor and the outline through the frame", () => {
    const frame = { offsetX: 4, offsetY: 8, scaleX: 0.5, scaleY: 0.25 };
    expect(
      placeAgentTarget(
        { phase: "move", x: 100, y: 100, box: { x: 40, y: 80, width: 120, height: 40 } },
        frame,
      ),
    ).toEqual({ left: 54, top: 33, outline: { left: 24, top: 28, width: 60, height: 10 } });
  });
});

describe("coverTopFrame", () => {
  it("fills a thumbnail of the same shape exactly", () => {
    expect(coverTopFrame({ width: 1280, height: 800 }, { width: 256, height: 160 })).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 0.2,
      scaleY: 0.2,
    });
  });

  it("centers a wider page across and crops a taller one at the bottom", () => {
    // Wider than the card: fills the height, overflows both sides equally.
    expect(coverTopFrame({ width: 2000, height: 800 }, { width: 250, height: 160 })).toEqual({
      offsetX: -75,
      offsetY: 0,
      scaleX: 0.2,
      scaleY: 0.2,
    });
    // Taller than the card: fills the width, anchored to the top.
    expect(coverTopFrame({ width: 1000, height: 2000 }, { width: 250, height: 160 })).toEqual({
      offsetX: 0,
      offsetY: 0,
      scaleX: 0.25,
      scaleY: 0.25,
    });
  });

  it("refuses a page with no size", () => {
    expect(coverTopFrame({ width: 0, height: 800 }, { width: 250, height: 160 })).toBeNull();
  });
});

describe("containFrame", () => {
  it("letterboxes a page into its box", () => {
    expect(containFrame({ width: 1000, height: 500 }, { width: 500, height: 500 })).toEqual({
      offsetX: 0,
      offsetY: 125,
      scaleX: 0.5,
      scaleY: 0.5,
    });
  });
});

describe("composeFrames", () => {
  it("maps through the inner frame, then the outer one", () => {
    const inner = { offsetX: 10, offsetY: 20, scaleX: 2, scaleY: 2 };
    const outer = { offsetX: 5, offsetY: 0, scaleX: 0.5, scaleY: 0.5 };
    const composed = composeFrames(inner, outer);
    const point = { phase: "move" as const, x: 30, y: 40 };
    const viaInner = placeAgentTarget(point, inner);
    const twoStep = placeAgentTarget({ phase: "move", x: viaInner.left, y: viaInner.top }, outer);
    const oneStep = placeAgentTarget(point, composed);
    expect([oneStep.left, oneStep.top]).toEqual([twoStep.left, twoStep.top]);
  });
});

describe("agentBrowserCursorOpacity", () => {
  it("stays readable between actions while the agent drives", () => {
    expect(agentBrowserCursorOpacity(true, "human")).toBe(1);
    expect(agentBrowserCursorOpacity(false, "agent")).toBe(0.6);
    expect(agentBrowserCursorOpacity(false, "human")).toBe(0.18);
  });
});
