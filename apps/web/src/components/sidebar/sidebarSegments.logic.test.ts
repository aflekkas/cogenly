import { describe, expect, it } from "vite-plus/test";

import {
  isSegmentSelectable,
  resolveSegmentSelection,
  shouldPersistSegmentFallback,
} from "./sidebarSegments.logic";

// Work's bar: Working, Needs you, Snoozed, Done.
describe("resolveSegmentSelection", () => {
  it("keeps a non-empty selection", () => {
    expect(resolveSegmentSelection([1, 2, 0, 38], 1)).toBe(1);
    expect(resolveSegmentSelection([0, 0, 0, 38], 3)).toBe(3);
  });

  it("falls back to the first non-empty segment in bar order", () => {
    expect(resolveSegmentSelection([1, 0, 0, 38], 1)).toBe(0);
    expect(resolveSegmentSelection([0, 2, 0, 38], 0)).toBe(1);
    expect(resolveSegmentSelection([0, 0, 4, 38], 1)).toBe(2);
    expect(resolveSegmentSelection([0, 0, 0, 38], 0)).toBe(3);
  });

  it("keeps the request when every segment is empty", () => {
    expect(resolveSegmentSelection([0, 0, 0, 0], 2)).toBe(2);
  });

  it("treats an unknown count as non-empty", () => {
    expect(resolveSegmentSelection([null, null], 1)).toBe(1);
    expect(resolveSegmentSelection([null, 0], 1)).toBe(0);
  });

  it("clamps an out-of-range request", () => {
    expect(resolveSegmentSelection([3, 1], 5)).toBe(1);
    expect(resolveSegmentSelection([], 0)).toBe(0);
  });
});

describe("isSegmentSelectable", () => {
  it("disables only a known zero", () => {
    expect(isSegmentSelectable(0)).toBe(false);
    expect(isSegmentSelectable(3)).toBe(true);
    expect(isSegmentSelectable(null)).toBe(true);
  });
});

describe("shouldPersistSegmentFallback", () => {
  it("stores the fallback once the chosen segment runs out", () => {
    expect(
      shouldPersistSegmentFallback({
        requested: 1,
        resolved: 0,
        previous: { requested: 1, count: 2 },
      }),
    ).toBe(true);
  });

  it("leaves a choice that was already empty, as while loading", () => {
    expect(shouldPersistSegmentFallback({ requested: 1, resolved: 0, previous: null })).toBe(false);
    expect(
      shouldPersistSegmentFallback({
        requested: 1,
        resolved: 0,
        previous: { requested: 1, count: 0 },
      }),
    ).toBe(false);
  });

  it("does nothing without a fallback or after the choice changed", () => {
    expect(
      shouldPersistSegmentFallback({
        requested: 1,
        resolved: 1,
        previous: { requested: 1, count: 2 },
      }),
    ).toBe(false);
    expect(
      shouldPersistSegmentFallback({
        requested: 2,
        resolved: 0,
        previous: { requested: 1, count: 2 },
      }),
    ).toBe(false);
  });
});
