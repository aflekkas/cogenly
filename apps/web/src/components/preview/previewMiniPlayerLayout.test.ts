import { describe, expect, it } from "vite-plus/test";

import {
  fitPreviewMiniPlayerFrameToBounds,
  PREVIEW_MINI_PLAYER_EDGE_GAP as GAP,
  resolvePreviewMiniPlayerVisibleBounds,
} from "./previewMiniPlayerLayout";

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
