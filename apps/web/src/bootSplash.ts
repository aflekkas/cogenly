// Clears the index.html boot splash (#boot-shell, a sibling of #root) once the app has
// painted. The pixel mosaic swipes up: an eased, gently wavy front climbs from the bottom of
// the window, and each block shrinks, fades and drifts up as the front reaches it, so the
// app is revealed below the front while the mosaic above it stays intact. The white glyph
// fades, shrinks slightly and lifts as the front reaches it. Reduced motion gets a quick
// fade. Only opacity and transform animate outside the canvas.

interface BootSplashPixels {
  /** Starts the exit; returns the delay (ms) until the front reaches a viewport y. */
  sweep(frontMs: number, blockMs: number): (viewportY: number) => number;
}

declare global {
  interface Window {
    cogenlyBootSplash?: BootSplashPixels;
  }
}

// The front climbs the window in FRONT_MS; each block (and the glyph) exits over EXIT_MS
// on the same ease-out once the front reaches it.
const FRONT_MS = 500;
const EXIT_MS = 290;
const EXIT_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const FADE_MS = 200;

let started = false;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// Frame-clocked wait, so the overlay lives exactly as long as the canvas sweep it shares a
// clock with.
function framesFor(durationMs: number): Promise<void> {
  const end = performance.now() + durationMs;
  return new Promise((resolve) => {
    const check = () => (performance.now() >= end ? resolve() : requestAnimationFrame(check));
    requestAnimationFrame(check);
  });
}

/** Runs once after the app's first commit. */
export async function dismissBootSplash(): Promise<void> {
  if (started) return;
  started = true;
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  shell.style.pointerEvents = "none";
  // Let the app's first frame paint underneath before revealing it.
  await nextFrame();
  await nextFrame();

  const mark = document.getElementById("boot-shell-mark");
  const pixels = window.cogenlyBootSplash;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !mark || !pixels) {
    await shell
      .animate({ opacity: [1, 0] }, { duration: FADE_MS, easing: "ease-out", fill: "forwards" })
      .finished.catch(() => null);
    shell.remove();
    return;
  }

  const frontReaches = pixels.sweep(FRONT_MS, EXIT_MS);
  const glyph = mark.getBoundingClientRect();
  await Promise.all([
    mark.animate(
      { opacity: [1, 0], transform: ["none", "translateY(-6px) scale(0.92)"] },
      {
        delay: frontReaches(glyph.top + glyph.height / 2),
        duration: EXIT_MS,
        easing: EXIT_EASING,
        fill: "forwards",
      },
    ).finished,
    framesFor(FRONT_MS + EXIT_MS),
  ]).catch(() => null);
  shell.remove();
}
