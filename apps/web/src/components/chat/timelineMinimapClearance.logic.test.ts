import { describe, expect, it } from "vite-plus/test";
import { resolveTimelineMinimapIndexFromPointer } from "./MessagesTimeline.logic";
import { resolveTimelineMinimapClearance } from "./timelineMinimapClearance.logic";

const rail = { left: 960, right: 984, top: 150, height: 600 };
const detailsCard = { left: 640, right: 988, bottom: 350 };
const resolve = (card = detailsCard) =>
  resolveTimelineMinimapClearance({ rail, detailsCard: card, viewportBottom: 850 });

describe("timeline minimap details clearance", () => {
  it("preserves the resting rail when the card closes or misses it", () => {
    const resting = { top: 0, height: 600 };
    expect(
      resolveTimelineMinimapClearance({ rail, detailsCard: null, viewportBottom: 850 }),
    ).toEqual(resting);
    expect(resolve({ ...detailsCard, right: rail.left })).toEqual(resting);
    expect(resolve({ ...detailsCard, left: rail.right })).toEqual(resting);
    expect(resolve({ ...detailsCard, bottom: 120 })).toEqual(resting);
    expect(resolve({ ...detailsCard, bottom: rail.top })).toEqual(resting);
  });

  it("clears the card and keeps the shortened rail inside the viewport", () => {
    expect(resolve()).toEqual({ top: 224, height: 452 });
    expect(resolve({ ...detailsCard, bottom: 450 })).toEqual({ top: 324, height: 352 });
  });

  it("moves a short rail below a card covering its entire resting box", () => {
    expect(
      resolveTimelineMinimapClearance({
        rail: { ...rail, height: 60 },
        detailsCard: { ...detailsCard, bottom: 400 },
        viewportBottom: 850,
      }),
    ).toEqual({ top: 274, height: 60 });
  });

  it("leaves a hidden rail at rest", () => {
    expect(
      resolveTimelineMinimapClearance({
        rail: { ...rail, height: 0 },
        detailsCard,
        viewportBottom: 850,
      }),
    ).toEqual({ top: 0, height: 0 });
  });

  it("maps the shifted rail endpoints and midpoint to the whole timeline", () => {
    const geometry = resolve();
    const railTop = rail.top + geometry.top;
    const indexAt = (pointerY: number) =>
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop,
        railHeight: geometry.height,
        pointerY,
      });
    expect(indexAt(railTop)).toBe(0);
    expect(indexAt(railTop + geometry.height / 2)).toBe(50);
    expect(indexAt(railTop + geometry.height)).toBe(100);
  });
});
