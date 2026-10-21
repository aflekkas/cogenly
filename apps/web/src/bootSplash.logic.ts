// Pure decisions for the boot splash exit (src/bootSplash.ts), kept apart so they can be
// tested without a DOM.

/** How the splash leaves: the pixel dissolve, a plain opacity fade, or straight out. */
export type BootSplashExit = "dissolve" | "fade" | "remove";

export const BOOT_SPLASH_DISSOLVE_MS = 1000;
export const BOOT_SPLASH_FADE_MS = 200;
/** Slack past an animation's own length before the exit stops waiting on it. */
export const BOOT_SPLASH_SLACK_MS = 400;
/** Waits on frames (rAF) give up after this, so a stalled renderer can't hold the exit. */
export const BOOT_SPLASH_FRAME_WAIT_MS = 120;
// The exit starts once the main thread has gone QUIET_MS without a long task (mount work,
// first data renders), or after MAX_WAIT_MS regardless.
export const BOOT_SPLASH_QUIET_MS = 250;
export const BOOT_SPLASH_MAX_WAIT_MS = 1500;
/**
 * Hard ceiling from the app's first commit to the splash leaving the DOM, on a timer that
 * doesn't depend on frames: two frame waits, the quiet wait, the dissolve, the fallback
 * fade, and slack for each.
 */
export const BOOT_SPLASH_DEADLINE_MS =
  2 * BOOT_SPLASH_FRAME_WAIT_MS +
  BOOT_SPLASH_MAX_WAIT_MS +
  BOOT_SPLASH_DISSOLVE_MS +
  BOOT_SPLASH_FADE_MS +
  3 * BOOT_SPLASH_SLACK_MS;

export function chooseBootSplashExit(input: {
  readonly reducedMotion: boolean;
  readonly hidden: boolean;
  readonly hasPixels: boolean;
}): BootSplashExit {
  // Nobody is watching a hidden page, and its frames may not run: leave at once.
  if (input.reducedMotion || input.hidden) return "remove";
  return input.hasPixels ? "dissolve" : "fade";
}

/** Resolves true when `promise` settles within `ms`, false when the wait runs out first. */
export function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
