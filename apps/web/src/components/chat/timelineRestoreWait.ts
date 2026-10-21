/**
 * Opening a thread hides the timeline until it sits at its restored position
 * (MessagesTimeline's first-layout hold). LegendList finishes a non-animated
 * scroll once a scroll event finds the viewport at the list's own target, or
 * else on a 100ms timer. A scroll that lands where the viewport already is
 * fires no event, and the end target it computes can sit a few pixels off the
 * real end, so most thread opens waited out the timer with the timeline blank.
 * These helpers notice the viewport is already in place, so the timeline can
 * hand the list a target it can finish on at once.
 */

export interface ViewportScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export type TimelineRestoreTarget =
  | { readonly kind: "end" }
  | { readonly kind: "offset"; readonly offset: number };

/** Whether the viewport rests at `target`, within a pixel. */
export function isViewportAtRestoreTarget(
  viewport: ViewportScrollMetrics,
  target: TimelineRestoreTarget,
): boolean {
  const maxOffset = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const targetOffset =
    target.kind === "end" ? maxOffset : Math.min(Math.max(0, target.offset), maxOffset);
  return Math.abs(viewport.scrollTop - targetOffset) <= 1;
}

export interface FrameScheduler {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

const browserFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Calls `onReached` once: with "viewport" on the first frame `isAtTarget`
 * reads true, or with "list" when the list's own `scrolling` completion
 * settles first. Returns a cancel function.
 */
export function waitForRestoreTarget(options: {
  readonly scrolling: unknown;
  readonly isAtTarget: () => boolean;
  readonly onReached: (via: "viewport" | "list") => void;
  readonly frames?: FrameScheduler;
}): () => void {
  const frames = options.frames ?? browserFrames;
  let done = false;
  let frame: number | null = null;
  const finish = (via: "viewport" | "list") => {
    if (done) return;
    done = true;
    if (frame !== null) frames.cancel(frame);
    frame = null;
    options.onReached(via);
  };
  const check = () => {
    frame = null;
    if (done) return;
    if (options.isAtTarget()) finish("viewport");
    else frame = frames.request(check);
  };
  frame = frames.request(check);
  void Promise.resolve(options.scrolling).then(() => finish("list"));
  return () => {
    done = true;
    if (frame !== null) frames.cancel(frame);
    frame = null;
  };
}
