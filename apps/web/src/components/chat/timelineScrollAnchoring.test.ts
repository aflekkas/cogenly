import { describe, expect, it } from "vite-plus/test";

import {
  isCarriedOverWheel,
  isCarriedOverWheelActive,
  nextWheelGesture,
  readTimelinePosition,
  rememberTimelinePosition,
  WHEEL_GESTURE_GAP_MS,
} from "./timelineScrollAnchoring";

describe("wheel gestures", () => {
  it("keeps a momentum stream in one gesture and starts a new one after a pause", () => {
    let gesture = nextWheelGesture(null, 1000);
    gesture = nextWheelGesture(gesture, 1016);
    gesture = nextWheelGesture(gesture, 1032);
    expect(gesture).toEqual({ startedAt: 1000, lastAt: 1032 });
    expect(nextWheelGesture(gesture, 1032 + WHEEL_GESTURE_GAP_MS + 1)).toEqual({
      startedAt: 1153,
      lastAt: 1153,
    });
  });

  it("treats momentum from before the thread opened as carried over", () => {
    // Scrolled the previous thread from t=1000, opened this one at t=1100.
    const momentum = nextWheelGesture(nextWheelGesture(null, 1000), 1110);
    expect(isCarriedOverWheel(momentum, 1100)).toBe(true);
    expect(isCarriedOverWheelActive(momentum, 1100, 1120)).toBe(true);
    // Once it has died down it no longer holds the thread at its end.
    expect(isCarriedOverWheelActive(momentum, 1100, 1110 + WHEEL_GESTURE_GAP_MS + 1)).toBe(false);
  });

  it("treats a gesture begun after the thread opened as the user scrolling it", () => {
    const fresh = nextWheelGesture(null, 1500);
    expect(isCarriedOverWheel(fresh, 1100)).toBe(false);
    expect(isCarriedOverWheel(null, 1100)).toBe(false);
  });
});

describe("remembered positions", () => {
  const position = { rowId: "row", offsetWithinRow: 0, scrollOffset: 0, atEnd: false };

  it("records a thread as at its end while it is following, whatever the scroll reads", () => {
    rememberTimelinePosition("env:following", position, true);
    expect(readTimelinePosition("env:following")?.atEnd).toBe(true);
  });

  it("records a scrolled-up position only once the user has left the end", () => {
    rememberTimelinePosition("env:reading", position, false);
    expect(readTimelinePosition("env:reading")?.atEnd).toBe(false);
  });
});
