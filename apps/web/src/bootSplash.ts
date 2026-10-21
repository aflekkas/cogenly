// Clears the index.html boot splash (#boot-shell, a sibling of #root) once the app has
// painted. The pixel mosaic dissolves in stop motion, rising up the window: on ~19fps ticks,
// small, even batches of blocks show one deeper frame and vanish, so the app shows through
// the gaps; the glyph pixelates into white blocks and steps out first. The inline script in
// index.html draws it. The exit waits for a quiet main thread so mount-time long tasks
// can't stall it. Reduced motion, or a hidden page, removes it at once.
//
// The dissolve runs on rAF, and a renderer can stop producing frames at any point (a hidden,
// minimized or occluded window, a background tab, a throttled webview). Every wait here is
// therefore bounded by a timer, and a deadline timer removes the splash regardless, so it
// can never stay painted (pointer-events off, half dissolved) over the live app.

import {
  BOOT_SPLASH_DEADLINE_MS,
  BOOT_SPLASH_DISSOLVE_MS,
  BOOT_SPLASH_FADE_MS,
  BOOT_SPLASH_FRAME_WAIT_MS,
  BOOT_SPLASH_MAX_WAIT_MS,
  BOOT_SPLASH_QUIET_MS,
  BOOT_SPLASH_SLACK_MS,
  chooseBootSplashExit,
  settlesWithin,
} from "./bootSplash.logic";

interface BootSplashPixels {
  /** Runs the exit dissolve over about durationMs; resolves after its last tick (with a timing log). */
  dissolve(durationMs: number): Promise<unknown>;
  /** Stops the mosaic's rAF loop and resize listener for good. */
  stop(): void;
}

declare global {
  interface Window {
    cogenlyBootSplash?: BootSplashPixels;
  }
}

let started = false;
let finished = false;
let deadline: ReturnType<typeof setTimeout> | undefined;

const nextFrame = () =>
  settlesWithin(
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    BOOT_SPLASH_FRAME_WAIT_MS,
  );

// Resolves after QUIET_MS with no long task. Without the Long Tasks API (Safari), it falls
// back to the next idle period.
function quietMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const supported = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
    if (!supported) {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => resolve(), { timeout: BOOT_SPLASH_QUIET_MS });
      } else setTimeout(resolve, BOOT_SPLASH_QUIET_MS);
      return;
    }
    let quietTimer = setTimeout(finish, BOOT_SPLASH_QUIET_MS);
    const capTimer = setTimeout(finish, BOOT_SPLASH_MAX_WAIT_MS);
    const observer = new PerformanceObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, BOOT_SPLASH_QUIET_MS);
    });
    observer.observe({ type: "longtask" });
    function finish() {
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      observer.disconnect();
      resolve();
    }
  });
}

function onVisibilityChange() {
  if (document.hidden) removeBootSplash();
}

/**
 * Takes the splash out of the DOM now and stops its canvas loop. Safe to call any number
 * of times. Leaves the boot error screen alone: that is the app's only UI.
 */
export function removeBootSplash(): void {
  if (finished) return;
  const shell = document.getElementById("boot-shell");
  if (shell?.dataset.state === "error") return;
  finished = true;
  clearTimeout(deadline);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.cogenlyBootSplash?.stop();
  shell?.remove();
  performance.mark("cogenly:splash:exit-end");
}

async function fadeOut(shell: HTMLElement): Promise<void> {
  const fade = shell.animate(
    { opacity: [getComputedStyle(shell).opacity, "0"] },
    { duration: BOOT_SPLASH_FADE_MS, easing: "ease-out", fill: "forwards" },
  );
  // The Web Animations timeline also stalls with frames, so don't wait on it alone.
  await settlesWithin(fade.finished, BOOT_SPLASH_FADE_MS + BOOT_SPLASH_SLACK_MS);
}

/** Runs once after the app's first commit. */
export async function dismissBootSplash(): Promise<void> {
  if (started) return;
  started = true;
  // User Timing marks, so a boot trace shows the splash phases next to long tasks.
  performance.mark("cogenly:splash:app-committed");
  const shell = document.getElementById("boot-shell");
  if (!shell || shell.dataset.state === "error") return;
  // From here the live app owns input; the splash is paint only, and only for a bounded time.
  shell.style.pointerEvents = "none";
  shell.setAttribute("aria-hidden", "true");
  deadline = setTimeout(removeBootSplash, BOOT_SPLASH_DEADLINE_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);

  const exitFor = () =>
    chooseBootSplashExit({
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      hidden: document.hidden,
      hasPixels: window.cogenlyBootSplash !== undefined,
    });
  if (exitFor() === "remove") return removeBootSplash();

  // Let the app's first frame paint underneath, then let mount work (effects, first data
  // renders) finish so no long task lands inside the 1s exit and stalls its ticks.
  await nextFrame();
  await nextFrame();
  await quietMainThread();
  if (finished) return;
  performance.mark("cogenly:splash:exit-start");

  const exit = exitFor();
  const pixels = window.cogenlyBootSplash;
  if (exit === "remove") return removeBootSplash();
  if (exit === "dissolve" && pixels) {
    const dissolved = await settlesWithin(
      pixels.dissolve(BOOT_SPLASH_DISSOLVE_MS),
      BOOT_SPLASH_DISSOLVE_MS + BOOT_SPLASH_SLACK_MS,
    );
    // A dissolve that stalled part way still has blocks up: fade those out.
    if (!dissolved && !finished) await fadeOut(shell);
  } else {
    await fadeOut(shell);
  }
  removeBootSplash();
}

let handoffHolders = 0;

/**
 * Held by BootSplashHandoff while it is mounted. Releasing the last hold (a real unmount,
 * not StrictMode's immediate remount) removes the splash.
 */
export function holdBootSplashHandoff(): () => void {
  handoffHolders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    handoffHolders--;
    setTimeout(() => {
      if (handoffHolders === 0) removeBootSplash();
    }, 0);
  };
}
