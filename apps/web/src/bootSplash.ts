// Clears the index.html boot splash (#boot-shell, a sibling of #root) once the app has
// painted. The pixel mosaic dissolves in stop motion, rising up the window: on ~19fps ticks,
// small, even batches of blocks show one deeper frame and vanish, so the app shows through
// the gaps; the glyph pixelates into white blocks and steps out first. The inline script in
// index.html draws it. The exit waits for a quiet main thread so mount-time long tasks
// can't stall it. Reduced motion gets a quick fade.

interface BootSplashPixels {
  /** Runs the exit dissolve over about durationMs; resolves after its last tick (with a timing log). */
  dissolve(durationMs: number): Promise<unknown>;
}

declare global {
  interface Window {
    cogenlyBootSplash?: BootSplashPixels;
  }
}

const DISSOLVE_MS = 1000;
const FADE_MS = 200;
// The exit starts once the main thread has gone QUIET_MS without a long task (mount work,
// first data renders), or after MAX_WAIT_MS regardless.
const QUIET_MS = 250;
const MAX_WAIT_MS = 1500;

let started = false;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// Resolves after QUIET_MS with no long task. Without the Long Tasks API (Safari), it falls
// back to the next idle period.
function quietMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const supported = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
    if (!supported) {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => resolve(), { timeout: QUIET_MS });
      } else setTimeout(resolve, QUIET_MS);
      return;
    }
    let quietTimer = setTimeout(finish, QUIET_MS);
    const capTimer = setTimeout(finish, MAX_WAIT_MS);
    const observer = new PerformanceObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, QUIET_MS);
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

/** Runs once after the app's first commit. */
export async function dismissBootSplash(): Promise<void> {
  if (started) return;
  started = true;
  // User Timing marks, so a boot trace shows the splash phases next to long tasks.
  performance.mark("cogenly:splash:app-committed");
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  shell.style.pointerEvents = "none";
  // Let the app's first frame paint underneath, then let mount work (effects, first data
  // renders) finish so no long task lands inside the 1s exit and stalls its ticks.
  await nextFrame();
  await nextFrame();
  await quietMainThread();
  performance.mark("cogenly:splash:exit-start");

  const pixels = window.cogenlyBootSplash;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !pixels) {
    await shell
      .animate({ opacity: [1, 0] }, { duration: FADE_MS, easing: "ease-out", fill: "forwards" })
      .finished.catch(() => null);
    shell.remove();
    return;
  }
  await pixels.dissolve(DISSOLVE_MS);
  shell.remove();
  performance.mark("cogenly:splash:exit-end");
}
