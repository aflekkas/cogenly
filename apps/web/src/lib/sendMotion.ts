/**
 * Send motion shared by the transcripts: a just-sent bubble rises straight up
 * into its place at the bottom, above the composer (no scale, no sideways
 * travel), on the `--ease-spring` token over SEND_MOTION_MS, while the
 * transcript glides to its live end in the same time, so the two read as one
 * upward movement. Opacity only under reduced motion, with no scroll
 * animation. History and remounts never play it; the caller decides what was
 * just sent. The chat timeline plays the rise as the `animate-message-send`
 * utility (index.css), which mirrors SEND_RISE_PX and SEND_MOTION_MS.
 */

/** The fallback for `--ease-spring` in index.css, used before styles resolve. */
export const SEND_SPRING_FALLBACK = "cubic-bezier(0.22, 1, 0.36, 1)";
export const SEND_MOTION_MS = 220;
/** How far below its place a sent bubble starts. */
export const SEND_RISE_PX = 20;
export const SEND_FADE_MS = 150;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export type Easing = (progress: number) => number;

/**
 * How long a glide waits for the sent row before its clock starts anyway. The
 * row commits a few frames after the send, and a clock started before then
 * spends the spring's fast opening on a layout that has not moved yet, so the
 * first visible frame jumps most of the way.
 */
export const SEND_GLIDE_START_WAIT_MS = 150;

/**
 * When a glide's clock starts: on the first frame the sent row is laid out,
 * or once it has waited long enough. Null keeps waiting. `now` is the time the
 * frame actually runs, not its timestamp: the frame the sent row commits in
 * is a long one, and a clock started at its timestamp is already well into
 * the spring by the next frame.
 */
export function glideClockStart(input: {
  readonly now: number;
  readonly firstFrameAt: number;
  readonly ready: boolean;
}): number | null {
  return input.ready || input.now - input.firstFrameAt >= SEND_GLIDE_START_WAIT_MS
    ? input.now
    : null;
}

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

/** A glide's progress at frame time `now`, 0 until its clock starts. */
export function glideProgress(now: number, startedAt: number | null): number {
  if (startedAt === null) return 0;
  return Math.max(0, Math.min(1, (now - startedAt) / SEND_MOTION_MS));
}

/** The scroll offset at `eased` progress from `from` toward `target`. */
export function scrollStep(from: number, target: number, eased: number): number {
  return from + (target - from) * Math.max(0, Math.min(1, eased));
}

/**
 * The scroll offset of a scroller's live end: the bottom of its latest
 * content. Never negative, so content shorter than the viewport stays put.
 */
export function liveEndScrollTarget(input: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): number {
  return Math.max(0, input.scrollHeight - input.clientHeight);
}

/**
 * Scrolls `node` to a target that may still move (rows measuring in) on the
 * send spring, in step with the bubble's rise. It runs the full duration even
 * when the target starts where the scroll already is, because the sent row is
 * usually not laid out yet on the first frame. Instant under reduced motion.
 * Returns a cancel that stops where the scroll is.
 */
export function animateScrollTop(
  node: HTMLElement,
  target: () => number | null,
  options: {
    /** Whether what the glide waits for is laid out; defaults to the target moving. */
    readonly ready?: () => boolean;
    readonly onDone?: (completed: boolean) => void;
  } = {},
): () => void {
  const finish = (completed: boolean) => options.onDone?.(completed);
  const first = target();
  if (first === null) {
    finish(false);
    return () => undefined;
  }
  if (prefersReducedMotion()) {
    node.scrollTop = first;
    finish(true);
    return () => undefined;
  }
  const ease = sendSpringEasing();
  const from = node.scrollTop;
  let firstFrameAt: number | null = null;
  let startedAt: number | null = null;
  let frame: number | null = requestAnimationFrame(function step(now) {
    firstFrameAt ??= now;
    const goal = target();
    if (goal === null || !node.isConnected) {
      frame = null;
      finish(false);
      return;
    }
    startedAt ??= glideClockStart({
      now: performance.now(),
      firstFrameAt,
      ready: options.ready?.() ?? Math.abs(goal - from) >= 1,
    });
    const progress = glideProgress(now, startedAt);
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

/**
 * The offset that draws a reference row at `eased` progress from where it was
 * before the send (`from`) toward where layout now puts it (`natural`). Zero
 * once the glide lands, so nothing is left translated.
 */
export function glideOffset(input: {
  readonly from: number;
  readonly natural: number;
  readonly eased: number;
}): number {
  return (input.from - input.natural) * (1 - Math.max(0, Math.min(1, input.eased)));
}

/**
 * Glides `node` to its live end for a send, as one motion however the end
 * moves. Within a viewport of the end the scroll pins to the end every frame
 * and the content is drawn on the send spring from where it sat before the
 * send (a `translate`, compositor only), so a short thread whose rows shift up
 * in layout as the sent row lands moves exactly like a long one that scrolls.
 * Further away there is nothing on screen to carry over, so the scroll itself
 * glides there. Instant under reduced motion. Returns a cancel that stops the
 * glide, leaving the scroll at the end.
 */
export function glideToLiveEnd(
  node: HTMLElement,
  options: {
    /** The element translated while layout catches up: the list's content. */
    readonly content: HTMLElement | null;
    /** The latest row on screen before the send, found again every frame. */
    readonly reference: () => Element | null;
    /** Whether the sent row is laid out yet: the glide's clock starts then. */
    readonly ready: () => boolean;
    readonly onDone?: (completed: boolean) => void;
  },
): () => void {
  const { content, reference } = options;
  const first = reference();
  if (
    prefersReducedMotion() ||
    content === null ||
    first === null ||
    liveEndScrollTarget(node) - node.scrollTop > node.clientHeight
  ) {
    // Far from the end the sent row is not rendered yet, so the clock starts
    // when the end itself moves to take it in.
    return animateScrollTop(node, () => liveEndScrollTarget(node), {
      ...(options.onDone ? { onDone: options.onDone } : {}),
    });
  }
  const from = first.getBoundingClientRect().top;
  const ease = sendSpringEasing();
  let applied = 0;
  // The end comes from the content's own layout box. `scrollHeight` counts a
  // downward translate as overflow and does not shrink back with it while the
  // scroll sits at the end, so pinning to it overshoots and drops back after.
  const contentBottom = () =>
    node.scrollTop +
    content.getBoundingClientRect().bottom -
    applied -
    node.getBoundingClientRect().top;
  const tail = Math.max(0, node.scrollHeight - contentBottom());
  const end = () =>
    liveEndScrollTarget({ scrollHeight: contentBottom() + tail, clientHeight: node.clientHeight });
  const apply = (offset: number) => {
    if (offset !== 0 && Math.abs(offset - applied) < 0.1) return;
    applied = offset;
    content.style.translate = offset === 0 ? "" : `0 ${offset}px`;
  };
  const finish = (completed: boolean) => {
    apply(0);
    options.onDone?.(completed);
  };
  let firstFrameAt: number | null = null;
  let startedAt: number | null = null;
  let frame: number | null = requestAnimationFrame(function step(now) {
    firstFrameAt ??= now;
    const row = reference();
    if (!node.isConnected || row === null) {
      frame = null;
      node.scrollTop = end();
      finish(row !== null);
      return;
    }
    node.scrollTop = end();
    const natural = row.getBoundingClientRect().top - applied;
    startedAt ??= glideClockStart({ now: performance.now(), firstFrameAt, ready: options.ready() });
    const progress = glideProgress(now, startedAt);
    apply(progress >= 1 ? 0 : glideOffset({ from, natural, eased: ease(progress) }));
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
