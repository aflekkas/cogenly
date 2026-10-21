import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  BOOT_SPLASH_DEADLINE_MS,
  BOOT_SPLASH_DISSOLVE_MS,
  BOOT_SPLASH_FADE_MS,
  BOOT_SPLASH_MAX_WAIT_MS,
  chooseBootSplashExit,
  settlesWithin,
} from "./bootSplash.logic";

describe("chooseBootSplashExit", () => {
  it("dissolves a visible page with the pixel canvas", () => {
    expect(chooseBootSplashExit({ reducedMotion: false, hidden: false, hasPixels: true })).toBe(
      "dissolve",
    );
  });

  it("fades when the canvas never started", () => {
    expect(chooseBootSplashExit({ reducedMotion: false, hidden: false, hasPixels: false })).toBe(
      "fade",
    );
  });

  it("removes at once under reduced motion or on a hidden page", () => {
    expect(chooseBootSplashExit({ reducedMotion: true, hidden: false, hasPixels: true })).toBe(
      "remove",
    );
    expect(chooseBootSplashExit({ reducedMotion: false, hidden: true, hasPixels: true })).toBe(
      "remove",
    );
  });
});

describe("settlesWithin", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a promise that settles in time", async () => {
    const result = settlesWithin(Promise.resolve(), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it("counts a rejection as settled", async () => {
    const result = settlesWithin(Promise.reject(new Error("cancelled")), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it("gives up on a promise that never settles, like a dissolve whose frames stopped", async () => {
    const result = settlesWithin(new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});

describe("BOOT_SPLASH_DEADLINE_MS", () => {
  it("outlasts the longest normal exit", () => {
    expect(BOOT_SPLASH_DEADLINE_MS).toBeGreaterThan(
      BOOT_SPLASH_MAX_WAIT_MS + BOOT_SPLASH_DISSOLVE_MS + BOOT_SPLASH_FADE_MS,
    );
  });
});
