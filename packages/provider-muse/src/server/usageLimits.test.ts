import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { parseMuseUsageLimits } from "./usageLimits.ts";

const observation = {
  observedAtMs: 1_792_166_400_000,
  tier: "pro",
  window: { usedPercent: 23, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
  weekly: { usedPercent: 47, resetsAtMs: 1_792_771_200_000 },
};

describe("Muse subscription limits", () => {
  it("maps real session and weekly windows and preserves observation/reset times", () => {
    const limits = parseMuseUsageLimits(observation);
    expect(limits?.checkedAt).toBe(
      DateTime.formatIso(DateTime.makeUnsafe(observation.observedAtMs)),
    );
    expect(limits?.windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 23,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.window.resetsAtMs)),
        windowDurationMins: 300,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 47,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.weekly.resetsAtMs)),
        windowDurationMins: 10080,
      },
    ]);
  });
  it("bounds over-quota values for bars without inventing missing observations", () => {
    expect(
      parseMuseUsageLimits({ ...observation, window: { ...observation.window, usedPercent: 120 } })
        ?.windows[0]?.usedPercent,
    ).toBe(100);
    for (const value of [
      undefined,
      {},
      { usedTokens: 42, windowTokens: 100 },
      { ...observation, weekly: { usedPercent: -1, resetsAtMs: 100 } },
      { ...observation, observedAtMs: NaN },
      { ...observation, window: { ...observation.window, windowDurationMins: 0 } },
    ]) {
      expect(parseMuseUsageLimits(value)).toBeUndefined();
    }
  });
});
