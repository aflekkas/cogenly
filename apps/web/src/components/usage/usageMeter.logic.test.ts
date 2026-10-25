import type { ServerProviderUsageWindow } from "@cogenly/contracts";
import { paceOf } from "@cogenly/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  headroomLabel,
  meterPercent,
  quotaLabel,
  windowMeter,
  windowShareLabel,
} from "./usageMeter.logic";

const NOW = Date.parse("2026-01-01T10:00:00.000Z");
const HOUR = 3_600_000;

/** A ten-hour window that is 60% elapsed: it resets in four hours. */
function usageWindow(
  usedPercent: number,
  timing: Partial<ServerProviderUsageWindow> = {
    resetsAt: new Date(NOW + 4 * HOUR).toISOString(),
    windowDurationMins: 600,
  },
): ServerProviderUsageWindow {
  return { id: "primary", kind: "session", label: "5h", usedPercent, ...timing };
}

describe("windowMeter", () => {
  it("drains in remaining mode and puts the marker at the time left", () => {
    expect(windowMeter(usageWindow(42), NOW, "remaining")).toEqual({
      fill: 58,
      marker: 40,
      quota: "58% left",
      clock: "40% of the window left",
    });
  });

  it("fills in used mode and puts the marker at the time elapsed", () => {
    expect(windowMeter(usageWindow(42), NOW, "used")).toEqual({
      fill: 42,
      marker: 60,
      quota: "42% used",
      clock: "60% of the window elapsed",
    });
  });

  it("keeps fill and marker on one scale: the two modes mirror each other", () => {
    for (const used of [0, 1, 17, 50, 83, 99, 100]) {
      const remaining = windowMeter(usageWindow(used), NOW, "remaining");
      const filling = windowMeter(usageWindow(used), NOW, "used");
      expect(remaining.fill + filling.fill).toBe(100);
      expect(remaining.marker! + filling.marker!).toBe(100);
    }
  });

  it("handles an untouched and an exhausted window", () => {
    expect(windowMeter(usageWindow(0), NOW, "remaining").fill).toBe(100);
    expect(windowMeter(usageWindow(0), NOW, "used").fill).toBe(0);
    expect(windowMeter(usageWindow(100), NOW, "remaining").fill).toBe(0);
    expect(windowMeter(usageWindow(100), NOW, "used").fill).toBe(100);
    expect(windowMeter(usageWindow(100), NOW, "used").quota).toBe("100% used");
    expect(windowMeter(usageWindow(0), NOW, "remaining").quota).toBe("100% left");
  });

  it("has no marker or clock text when the window's length is unknown", () => {
    const unknown = usageWindow(30, { resetsAt: new Date(NOW + 4 * HOUR).toISOString() });
    expect(windowMeter(unknown, NOW, "remaining")).toEqual({
      fill: 70,
      marker: null,
      quota: "70% left",
      clock: null,
    });
    expect(windowMeter(unknown, NOW, "used")).toEqual({
      fill: 30,
      marker: null,
      quota: "30% used",
      clock: null,
    });
  });

  it("has no marker when the reset time is unknown", () => {
    const unknown = usageWindow(30, { windowDurationMins: 600 });
    expect(windowMeter(unknown, NOW, "used").marker).toBeNull();
  });

  it("pins the marker to the ends once the window has not opened or has closed", () => {
    const notOpen = usageWindow(0, {
      resetsAt: new Date(NOW + 20 * HOUR).toISOString(),
      windowDurationMins: 600,
    });
    expect(windowMeter(notOpen, NOW, "remaining").marker).toBe(100);
    expect(windowMeter(notOpen, NOW, "used").marker).toBe(0);
    const closed = usageWindow(0, {
      resetsAt: new Date(NOW - HOUR).toISOString(),
      windowDurationMins: 600,
    });
    expect(windowMeter(closed, NOW, "remaining").marker).toBe(0);
    expect(windowMeter(closed, NOW, "used").marker).toBe(100);
  });

  it("leaves the pace verdict to the window, not the mode", () => {
    // 42% used against 60% elapsed is under pace; mode changes only wording.
    expect(paceOf(usageWindow(42), NOW)).toBe("under");
    expect(paceOf(usageWindow(80), NOW)).toBe("ahead");
  });
});

describe("labels", () => {
  it("words quota as left or used", () => {
    expect(quotaLabel(58, "remaining")).toBe("58% left");
    expect(quotaLabel(58, "used")).toBe("42% used");
  });

  it("words the clock as left or elapsed", () => {
    expect(windowShareLabel(40, "remaining")).toBe("40% of the window left");
    expect(windowShareLabel(40, "used")).toBe("60% of the window elapsed");
  });

  it("converts a handoff candidate's headroom and keeps unknown unknown", () => {
    expect(headroomLabel(62, "remaining")).toBe("62% left");
    expect(headroomLabel(62, "used")).toBe("38% used");
    expect(headroomLabel(null, "remaining")).toBe("Usage unknown");
    expect(headroomLabel(null, "used")).toBe("Usage unknown");
  });

  it("scales a percent for the bar", () => {
    expect(meterPercent(0, "used")).toBe(100);
    expect(meterPercent(100, "used")).toBe(0);
    expect(meterPercent(37, "remaining")).toBe(37);
  });
});
