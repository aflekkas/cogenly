// Hands the index.html boot splash (#boot-shell, a sibling of #root) off to the app.
// Once the shell has painted, the whole orange field flies into the sidebar's CogenlyMark
// as one motion: the field (the window-sized pixel mosaic) and the white glyph share one
// path and one ease-out curve, the mosaic drops out
// bottom-up during the flight, the mark's tile fades in under the glyph, and the last
// frames cross-fade to the real mark. Without a visible target, or with reduced motion,
// the splash fades instead. Only transform, opacity and clip-path animate.

interface BootSplashPixels {
  dissipate(durationMs: number): void;
}

declare global {
  interface Window {
    cogenlyBootSplash?: BootSplashPixels;
  }
}

const MORPH_MS = 680;
const CROSSFADE_MS = 80;
const SETTLE_MS = 180;
const TARGET_WAIT_MS = 400;
const FADE_MS = 200;
// Emphasized decelerate: the flight leaves fast and lands soft.
const FLIGHT_EASING = "cubic-bezier(0.05, 0.7, 0.1, 1)";
// The mark's tile corner, rx 28 on its 128 box.
const TILE_CORNER_RATIO = 28 / 128;

let target: Element | null = null;
let notifyTarget: (() => void) | null = null;
let started = false;

/** Registers the visible sidebar mark as the morph destination. Returns the cleanup. */
export function registerBootSplashTarget(element: Element): () => void {
  target = element;
  notifyTarget?.();
  return () => {
    if (target === element) target = null;
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function waitForTarget(timeoutMs: number): Promise<void> {
  if (target) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      notifyTarget = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    notifyTarget = finish;
  });
}

function visibleRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  const offscreen =
    rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight;
  return rect.width < 1 || rect.height < 1 || offscreen ? null : rect;
}

// Fast-forwards the orbit loop to its docked rest within SETTLE_MS.
function settleLoop(logo: Element) {
  for (const animation of logo.getAnimations({ subtree: true })) {
    const duration = Number(animation.effect?.getComputedTiming().duration) || 0;
    const time = Number(animation.currentTime) || 0;
    if (duration <= 0) {
      animation.cancel();
      continue;
    }
    animation.effect?.updateTiming({ iterations: Math.floor(time / duration) + 1 });
    animation.updatePlaybackRate(Math.max(1, (duration - (time % duration)) / SETTLE_MS));
  }
}

async function fadeOut(shell: HTMLElement, durationMs: number) {
  await shell
    .animate({ opacity: [1, 0] }, { duration: durationMs, easing: "ease-out", fill: "forwards" })
    .finished.catch(() => null);
  shell.remove();
}

/** Runs once after the app's first commit. */
export async function dismissBootSplash(): Promise<void> {
  if (started) return;
  started = true;
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  shell.style.pointerEvents = "none";
  // Let the shell paint, then give the sidebar mark a moment to mount.
  await nextFrame();
  await nextFrame();
  await waitForTarget(TARGET_WAIT_MS);

  const mark = document.getElementById("boot-shell-mark");
  const logo = document.getElementById("boot-shell-logo");
  const tile = document.getElementById("boot-shell-tile");
  const pixels = document.getElementById("boot-shell-pixels");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const destination = target;
  const to = destination && !reduceMotion ? visibleRect(destination) : null;
  if (!destination || !to || !mark || !logo || !tile || !pixels) {
    await fadeOut(shell, FADE_MS);
    return;
  }

  const from = mark.getBoundingClientRect();
  const width = innerWidth;
  const height = innerHeight;
  // The field is the window-sized orange layer holding the pixel mosaic. One transform flies
  // it onto the target (its aspect eases to square on the way) while its clip rounds the
  // corners from 0 to the tile's radius, measured in the field's own, pre-scale units.
  const field = document.createElement("div");
  Object.assign(field.style, { position: "fixed", inset: "0", overflow: "hidden" });
  shell.prepend(field);
  field.append(pixels);

  const targetX = to.left + to.width / 2;
  const targetY = to.top + to.height / 2;
  const scaleX = to.width / width;
  const scaleY = to.height / height;
  const radius = to.width * TILE_CORNER_RATIO;
  const fieldFlight = `translate(${targetX - width / 2}px, ${targetY - height / 2}px) scale(${scaleX}, ${scaleY})`;
  const markFlight = `translate(${targetX - (from.left + from.width / 2)}px, ${targetY - (from.top + from.height / 2)}px) scale(${to.width / from.width})`;
  const eased = { duration: MORPH_MS, easing: FLIGHT_EASING, fill: "forwards" } as const;
  // Opacity runs on linear time so its offsets are moments in the flight, not eased progress.
  const linear = { duration: MORPH_MS, easing: "linear", fill: "forwards" } as const;
  const fadeStart = 1 - CROSSFADE_MS / MORPH_MS;

  // The dot snaps home as the flight starts; no hold between the two.
  settleLoop(logo);
  window.cogenlyBootSplash?.dissipate(MORPH_MS * 0.85);
  const reveal = destination.animate({ opacity: [0, 0, 1], offset: [0, fadeStart, 1] }, linear);
  await Promise.all([
    field.animate(
      {
        transform: ["none", fieldFlight],
        clipPath: [
          "inset(0px round 0px)",
          `inset(0px round ${radius / scaleX}px / ${radius / scaleY}px)`,
        ],
      },
      eased,
    ).finished,
    mark.animate({ transform: ["none", markFlight] }, eased).finished,
    mark.animate({ opacity: [1, 1, 0], offset: [0, fadeStart, 1] }, linear).finished,
    tile.animate({ opacity: [0, 0, 1], offset: [0, 0.35, fadeStart] }, linear).finished,
    reveal.finished,
  ]).catch(() => null);
  reveal.cancel();
  shell.remove();
}
