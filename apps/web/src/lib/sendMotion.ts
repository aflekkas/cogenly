/**
 * Send motion shared by the transcripts: a just-sent bubble rises straight up
 * into place (no scale, no sideways travel) on the `--ease-spring` token over
 * SEND_MOTION_MS, while the transcript scrolls it to where it lands in the same
 * time, so the two read as one upward movement. Opacity only under reduced
 * motion. History and remounts never play it; the caller decides what was
 * just sent. The chat timeline plays the rise as the `animate-message-send`
 * utility (index.css), which mirrors SEND_RISE_PX and SEND_MOTION_MS.
 */

/** The fallback for `--ease-spring` in index.css, used before styles resolve. */
export const SEND_SPRING_FALLBACK = "cubic-bezier(0.22, 1, 0.36, 1)";
export const SEND_MOTION_MS = 260;
/** How far below its place a sent bubble starts. */
export const SEND_RISE_PX = 20;
export const SEND_FADE_MS = 150;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export type Easing = (progress: number) => number;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

/** The `--ease-spring` token as a CSS timing function. */
export function sendSpringCss(): string {
  if (typeof document === "undefined") return SEND_SPRING_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--ease-spring").trim();
  return value.startsWith("cubic-bezier(") ? value : SEND_SPRING_FALLBACK;
}

/** Parses `cubic-bezier(a, b, c, d)` into an easing function, or null. */
export function parseCubicBezier(css: string): Easing | null {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(css.trim());
  if (!match?.[1]) return null;
  const parts = match[1].split(",").map((part) => Number.parseFloat(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x1, y1, x2, y2] = parts as [number, number, number, number];
  return cubicBezier(x1, y1, x2, y2);
}

/** A CSS cubic-bezier timing function, solved for x by Newton steps with a bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let step = 0; step < 8; step += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let step = 0; step < 32; step += 1) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) return t;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  };
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return sampleY(solve(progress));
  };
}

export function sendSpringEasing(): Easing {
  return parseCubicBezier(sendSpringCss()) ?? parseCubicBezier(SEND_SPRING_FALLBACK)!;
}

/** Keyframes for a sent bubble rising into place: up from below, filling in. */
export function riseKeyframes(reduced: boolean): Keyframe[] {
  return reduced
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [
        { opacity: 0, transform: `translateY(${SEND_RISE_PX}px)` },
        { opacity: 1, transform: "none" },
      ];
}

/** Plays the send rise on a just-sent bubble. Opacity only under reduced motion. */
export function riseIn(element: HTMLElement): Animation {
  const reduced = prefersReducedMotion();
  return element.animate(riseKeyframes(reduced), {
    duration: reduced ? SEND_FADE_MS : SEND_MOTION_MS,
    easing: sendSpringCss(),
  });
}

/** The scroll offset at `eased` progress from `from` toward `target`. */
export function scrollStep(from: number, target: number, eased: number): number {
  return from + (target - from) * Math.max(0, Math.min(1, eased));
}

/**
 * Scrolls `node` to a target that may still move (rows measuring in) on the
 * send spring, in step with the bubble's rise. Instant under reduced motion.
 * Returns a cancel that stops where the scroll is.
 */
export function animateScrollTop(
  node: HTMLElement,
  target: () => number | null,
  options: { readonly onDone?: (completed: boolean) => void } = {},
): () => void {
  const finish = (completed: boolean) => options.onDone?.(completed);
  const first = target();
  if (first === null) {
    finish(false);
    return () => undefined;
  }
  if (prefersReducedMotion() || Math.abs(first - node.scrollTop) < 1) {
    node.scrollTop = first;
    finish(true);
    return () => undefined;
  }
  const ease = sendSpringEasing();
  const from = node.scrollTop;
  let startedAt: number | null = null;
  let frame: number | null = requestAnimationFrame(function step(now) {
    startedAt ??= now;
    const progress = Math.min(1, (now - startedAt) / SEND_MOTION_MS);
    const goal = target();
    if (goal === null || !node.isConnected) {
      frame = null;
      finish(false);
      return;
    }
    node.scrollTop = scrollStep(from, goal, ease(progress));
    if (progress >= 1) {
      frame = null;
      finish(true);
      return;
    }
    frame = requestAnimationFrame(step);
  });
  return () => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
    finish(false);
  };
}
