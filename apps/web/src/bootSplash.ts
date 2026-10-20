// Clears the index.html boot splash (#boot-shell, a sibling of #root) once the app has
// painted. The pixel mosaic dissolves in stop motion, rising up the window: on ~19fps ticks,
// small, even batches of blocks show one deeper frame and vanish, so
// the app shows through the gaps; the glyph steps out on the same ticks. The inline script
// in index.html draws it. Reduced motion gets a quick fade.

interface BootSplashPixels {
  /** Runs the exit dissolve over about durationMs; resolves after its last tick. */
  dissolve(durationMs: number): Promise<void>;
}

declare global {
  interface Window {
    cogenlyBootSplash?: BootSplashPixels;
  }
}

const DISSOLVE_MS = 1000;
const FADE_MS = 200;

let started = false;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
}
