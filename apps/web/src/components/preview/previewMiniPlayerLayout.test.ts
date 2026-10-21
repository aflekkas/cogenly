import { describe, expect, it } from "vite-plus/test";

import {
  fitPreviewMiniPlayerFrameToBounds,
  PREVIEW_MINI_PLAYER_EDGE_GAP as GAP,
  previewMiniPlayerFrameHeight,
  previewMiniPlayerWidthForHeight,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerFrame,
  resolvePreviewMiniPlayerVisibleBounds,
} from "./previewMiniPlayerLayout";

describe("floating preview chrome", () => {
  const container = { width: 1400, height: 900 };
  const page = { width: 1000, height: 500 };
  const source = { ...page, chrome: 32 };

  it("adds the chrome to the page height and inverts it", () => {
    expect(previewMiniPlayerFrameHeight(400, source)).toBe(232);
    expect(previewMiniPlayerWidthForHeight(232, source)).toBe(400);
    expect(previewMiniPlayerFrameHeight(400, page)).toBe(200);
  });

  it("sizes a fresh player so the page fills the frame above the chrome", () => {
    const frame = resolvePreviewMiniPlayerFrame({ width: null, position: null, source, container });
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(320 / 2 + 32);
  });

  it("keeps the chrome at full height for a tall page at the minimum width", () => {
    const tall = { width: 500, height: 1000, chrome: 32 };
    const frame = resolvePreviewMiniPlayerFrame({
      width: null,
      position: null,
      source: tall,
      container,
    });
    // The 240px minimum width wins over the default box: 480 of page plus the chrome.
    expect(frame).toMatchObject({ width: 240, height: 512 });
  });

  it("resizes from an edge or corner along the chrome-aware size line", () => {
    const start = { x: 100, y: 100, width: 400, height: 232 };
    const east = resizePreviewMiniPlayer({
      start,
      direction: "east",
      delta: { x: 100, y: 0 },
      source,
      container,
    });
    expect(east).toMatchObject({ width: 500, height: 282 });
    const south = resizePreviewMiniPlayer({
      start,
      direction: "south",
      delta: { x: 0, y: 50 },
      source,
      container,
    });
    expect(south).toMatchObject({ width: 500, height: 282 });
    const corner = resizePreviewMiniPlayer({
      start,
      direction: "southeast",
      delta: { x: 100, y: 50 },
      source,
      container,
    });
    expect(corner).toMatchObject({ width: 500, height: 282 });
  });

  it("shrinks into tight bounds by scaling only the page", () => {
    const frame = fitPreviewMiniPlayerFrameToBounds(
      { x: 0, y: 0, width: 400, height: 232 },
      { left: 0, top: 0, right: 224, bottom: 600 },
      source,
    );
    expect(frame).toEqual({ x: GAP, y: GAP, width: 200, height: 132 });
  });
});

describe("floating preview viewport fit", () => {
  it("only reports the part of the container the window shows", () => {
    expect(
      resolvePreviewMiniPlayerVisibleBounds(
        { x: 300, y: 40 },
        { width: 1400, height: 900 },
        { width: 1440, height: 900 },
      ),
    ).toEqual({ left: 0, top: 0, right: 1140, bottom: 860 });
  });

  it("pulls a frame saved past the visible edge back on screen with the margin", () => {
    const bounds = { left: 0, top: 0, right: 1000, bottom: 700 };
    expect(
      fitPreviewMiniPlayerFrameToBounds({ x: 900, y: 650, width: 320, height: 200 }, bounds),
    ).toEqual({ x: 1000 - GAP - 320, y: 700 - GAP - 200, width: 320, height: 200 });
  });

  it("shrinks at its aspect ratio when the visible area is smaller than the frame", () => {
    const frame = fitPreviewMiniPlayerFrameToBounds(
      { x: 0, y: 0, width: 400, height: 200 },
      { left: 0, top: 0, right: 224, bottom: 600 },
    );
    expect(frame).toEqual({ x: GAP, y: GAP, width: 200, height: 100 });
  });

  it("keeps the same frame when it already fits", () => {
    const frame = { x: 40, y: 40, width: 320, height: 200 };
    expect(
      fitPreviewMiniPlayerFrameToBounds(frame, { left: 0, top: 0, right: 1000, bottom: 700 }),
    ).toBe(frame);
  });
});
