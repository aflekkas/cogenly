import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  crossfadeModeSwitch,
  MAIN_PANE_WAIT_MS,
  modeSwitchCrossfadeRunning,
  settleModeSwitchMainPane,
  waitForModeSwitchMainPane,
} from "./modeSwitchMotion";

afterEach(() => {
  vi.useRealTimers();
});

describe("crossfadeModeSwitch", () => {
  it("switches at once where there is no crossfade to run", () => {
    const update = vi.fn(() => true);
    crossfadeModeSwitch(update);
    expect(update).toHaveBeenCalledOnce();
    expect(modeSwitchCrossfadeRunning()).toBe(false);
  });
});

describe("waitForModeSwitchMainPane", () => {
  it("resolves when the main pane's new content commits", async () => {
    vi.useFakeTimers();
    let settled = false;
    const waiting = waitForModeSwitchMainPane().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    settleModeSwitchMainPane();
    await waiting;
    expect(settled).toBe(true);
  });

  it("stops waiting for content that never lands", async () => {
    vi.useFakeTimers();
    let settled = false;
    const waiting = waitForModeSwitchMainPane().then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(MAIN_PANE_WAIT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await waiting;
    expect(settled).toBe(true);
  });

  it("lets a newer switch take over the wait", async () => {
    vi.useFakeTimers();
    let olderSettled = false;
    let newerSettled = false;
    const older = waitForModeSwitchMainPane().then(() => {
      olderSettled = true;
    });
    const newer = waitForModeSwitchMainPane().then(() => {
      newerSettled = true;
    });
    await older;
    expect(olderSettled).toBe(true);
    expect(newerSettled).toBe(false);
    settleModeSwitchMainPane();
    await newer;
    expect(newerSettled).toBe(true);
  });
});
