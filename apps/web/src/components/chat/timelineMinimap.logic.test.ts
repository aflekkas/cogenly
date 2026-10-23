import { describe, expect, it } from "vite-plus/test";

import {
  buildTimelineMinimapMarks,
  resolveTimelineMinimapMarkBudget,
  resolveTimelineMinimapMarkOrdinal,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHighlightOrdinal,
  TIMELINE_MINIMAP_MIN_MARK_SPACING_PX,
} from "./timelineMinimap.logic";

const typed = (count: number) => Array.from({ length: count }, () => ({ typed: true }));

describe("buildTimelineMinimapMarks", () => {
  it("draws one mark per message while they fit", () => {
    const marks = buildTimelineMinimapMarks(typed(4), 10);
    expect(marks.map((mark) => mark.itemIndex)).toEqual([0, 1, 2, 3]);
    expect(marks.map((mark) => Math.round(mark.topPercent))).toEqual([0, 33, 67, 100]);
  });

  it("caps a huge thread at the rail's budget and covers every message once", () => {
    const marks = buildTimelineMinimapMarks(typed(1_000), 80);
    expect(marks).toHaveLength(80);
    expect(marks[0]?.startIndex).toBe(0);
    expect(marks.at(-1)?.endIndex).toBe(999);
    for (let ordinal = 1; ordinal < marks.length; ordinal += 1) {
      expect(marks[ordinal]?.startIndex).toBe((marks[ordinal - 1]?.endIndex ?? -2) + 1);
    }
  });

  it("keeps aggregated marks evenly spaced on the rail", () => {
    const railHeight = 600;
    const marks = buildTimelineMinimapMarks(
      typed(5_000),
      resolveTimelineMinimapMarkBudget(railHeight),
    );
    const gaps = marks
      .slice(1)
      .map((mark, index) => ((mark.topPercent - marks[index]!.topPercent) / 100) * railHeight);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(TIMELINE_MINIMAP_MIN_MARK_SPACING_PX - 0.5);
  });

  it("represents a bucket by the message the user typed, not agent sends", () => {
    const items = [
      { typed: false },
      { typed: false },
      { typed: true },
      { typed: false },
      { typed: false },
      { typed: false },
    ];
    const marks = buildTimelineMinimapMarks(items, 2);
    expect(marks.map((mark) => [mark.itemIndex, mark.typed])).toEqual([
      [2, true],
      [3, false],
    ]);
  });
});

describe("resolveTimelineMinimapMarkBudget", () => {
  it("draws a bounded default before the rail is measured", () => {
    expect(resolveTimelineMinimapMarkBudget(0)).toBe(48);
  });

  it("grows with the rail", () => {
    expect(resolveTimelineMinimapMarkBudget(60)).toBe(11);
    expect(resolveTimelineMinimapMarkBudget(600)).toBe(101);
  });
});

describe("resolveTimelineMinimapMarkOrdinal", () => {
  it("finds the bucket holding a message", () => {
    const marks = buildTimelineMinimapMarks(typed(100), 10);
    expect(resolveTimelineMinimapMarkOrdinal(marks, 0)).toBe(0);
    expect(resolveTimelineMinimapMarkOrdinal(marks, 55)).toBe(5);
    expect(resolveTimelineMinimapMarkOrdinal(marks, 99)).toBe(9);
    expect(resolveTimelineMinimapMarkOrdinal(marks, 100)).toBeNull();
  });
});

describe("resolveTimelineMinimapCurrentIndex", () => {
  const itemBounds = [
    { top: 0, height: 100 },
    { top: 400, height: 100 },
    { top: 800, height: 100 },
    { top: 1_600, height: 100 },
  ];

  it("is the message that starts above the reading line", () => {
    // Viewport 300..900: the reading line sits at 500.
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 300, scrollBottom: 900, itemBounds }),
    ).toBe(1);
  });

  it("stays on the message the reader is under inside a long reply", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 1_000, scrollBottom: 1_500, itemBounds }),
    ).toBe(2);
  });

  it("is the last message once the thread is scrolled to its end", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({ scrollTop: 1_100, scrollBottom: 1_800, itemBounds }),
    ).toBe(3);
  });

  it("is empty before any message has a position", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({
        scrollTop: 0,
        scrollBottom: 500,
        itemBounds: [{ top: null, height: null }],
      }),
    ).toBeNull();
  });
});

describe("resolveTimelineMinimapHighlightOrdinal", () => {
  const marks = buildTimelineMinimapMarks(typed(100), 10);

  it("brightens only the mark holding the message being read", () => {
    expect(
      resolveTimelineMinimapHighlightOrdinal(marks, { hoverIndex: null, currentIndex: 42 }),
    ).toBe(4);
  });

  it("moves the one bright mark to the hovered mark instead of adding a second", () => {
    expect(
      resolveTimelineMinimapHighlightOrdinal(marks, { hoverIndex: 87, currentIndex: 42 }),
    ).toBe(8);
  });

  it("draws no bright mark before the position is known", () => {
    expect(
      resolveTimelineMinimapHighlightOrdinal(marks, { hoverIndex: null, currentIndex: null }),
    ).toBeNull();
  });
});
