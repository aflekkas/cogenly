import { observeResize } from "./observeResize";

/**
 * Panel open and close without per-frame layout. A toggle lays the page out
 * once at its final size, the panel slides on transform, and content marked
 * with `data-panel-flip` glides from where it was to its new place (FLIP):
 * `start` for content held to the left edge, `center` (the default) for
 * centered columns, `end` for content held to the right edge. A marked element
 * inside another marked element plays only its difference from that ancestor,
 * so a right-anchored card inside a centered column stays still.
 *
 * Mark the content, never the pane: a transform makes the pane the containing
 * block of its `position: fixed` controls, and they jump with it.
 */
export type PanelFlipAnchor = "start" | "center" | "end";

/** Matches ease-standard in index.css; panel slides ride the same curve. */
export const PANEL_MOTION_EASING = "cubic-bezier(0.2, 0, 0, 1)";

const PANEL_FLIP_SELECTOR = "[data-panel-flip]";
const PANEL_FLIP_ANIMATION_ID = "panel-flip";

interface HorizontalBounds {
  readonly left: number;
  readonly right: number;
}

export interface PanelFlipMeasurement {
  readonly anchor: PanelFlipAnchor;
  readonly before: HorizontalBounds;
  readonly after: HorizontalBounds;
  /** Index of the nearest marked ancestor in the same list. */
  readonly parent: number | null;
}

export interface PanelFlipSnapshot {
  readonly entries: ReadonlyArray<{
    readonly element: HTMLElement;
    readonly bounds: HorizontalBounds;
  }>;
}

function anchorX(bounds: HorizontalBounds, anchor: PanelFlipAnchor): number {
  if (anchor === "start") return bounds.left;
  if (anchor === "end") return bounds.right;
  return (bounds.left + bounds.right) / 2;
}

/** The starting translateX for each element; 0 means it does not move. */
export function resolvePanelFlipOffsets(measurements: readonly PanelFlipMeasurement[]): number[] {
  const deltas = measurements.map(
    (entry) => anchorX(entry.before, entry.anchor) - anchorX(entry.after, entry.anchor),
  );
  return measurements.map((entry, index) => {
    const offset = deltas[index]! - (entry.parent === null ? 0 : deltas[entry.parent]!);
    return Math.abs(offset) < 0.5 ? 0 : offset;
  });
}

function readAnchor(element: HTMLElement): PanelFlipAnchor {
  const anchor = element.dataset.panelFlip;
  return anchor === "start" || anchor === "end" ? anchor : "center";
}

function readBounds(element: HTMLElement): HorizontalBounds | null {
  const rect = element.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : { left: rect.left, right: rect.right };
}

/** Records where marked content inside root sits now. Call before the layout changes. */
export function capturePanelFlip(root: ParentNode | null): PanelFlipSnapshot | null {
  if (!root) return null;
  const entries: Array<PanelFlipSnapshot["entries"][number]> = [];
  for (const element of root.querySelectorAll<HTMLElement>(PANEL_FLIP_SELECTOR)) {
    const bounds = readBounds(element);
    if (bounds) entries.push({ element, bounds });
  }
  return { entries };
}

/**
 * Glides captured content from its old place to the committed layout. Call it
 * from a layout effect. It plays in this frame's resize step, once
 * observeResize has re-rendered size-derived positions (the mini player, the
 * canvas lanes), so it reads final places and still starts before paint.
 */
export function playPanelFlip(snapshot: PanelFlipSnapshot, durationMs: number): void {
  let played = false;
  const stopObserving = observeResize(document.documentElement, () => {
    if (played) return;
    played = true;
    // Resize callbacks share one flushSync; the microtask runs after it commits.
    queueMicrotask(() => {
      stopObserving();
      playMeasuredPanelFlip(snapshot, durationMs);
    });
  });
}

function playMeasuredPanelFlip(snapshot: PanelFlipSnapshot, durationMs: number): void {
  // Retarget an interrupted flip: the snapshot holds where content was drawn,
  // so settle the running transform and read where layout puts it now.
  for (const { element } of snapshot.entries) {
    for (const animation of element.getAnimations()) {
      if (animation.id === PANEL_FLIP_ANIMATION_ID) animation.cancel();
    }
  }
  const elements: HTMLElement[] = [];
  const measurements: PanelFlipMeasurement[] = [];
  const indexByElement = new Map<HTMLElement, number>();
  for (const { element, bounds } of snapshot.entries) {
    if (!element.isConnected) continue;
    const after = readBounds(element);
    if (!after) continue;
    indexByElement.set(element, elements.length);
    elements.push(element);
    measurements.push({ anchor: readAnchor(element), before: bounds, after, parent: null });
  }
  // querySelectorAll returns document order, so every ancestor is indexed first.
  const resolved = measurements.map((measurement, index) => {
    const ancestor = elements[index]!.parentElement?.closest<HTMLElement>(PANEL_FLIP_SELECTOR);
    return { ...measurement, parent: (ancestor && indexByElement.get(ancestor)) ?? null };
  });
  resolvePanelFlipOffsets(resolved).forEach((offset, index) => {
    if (offset === 0) return;
    const animation = elements[index]!.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
      { duration: durationMs, easing: PANEL_MOTION_EASING },
    );
    animation.id = PANEL_FLIP_ANIMATION_ID;
  });
  notifyPanelMotion(durationMs);
}

const motionListeners = new Set<() => void>();
let motionFrame = 0;
let motionEnd = 0;

/**
 * Calls listener on every frame while a panel moves, then once at rest. For
 * surfaces positioned from a measured rect (the hosted browser) that must
 * follow a transform, which no ResizeObserver reports.
 */
export function subscribePanelMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => motionListeners.delete(listener);
}

/** Starts or extends the frame loop for a panel motion of durationMs. */
export function notifyPanelMotion(durationMs: number): void {
  if (motionListeners.size === 0) return;
  motionEnd = Math.max(motionEnd, performance.now() + durationMs);
  for (const listener of motionListeners) listener();
  if (motionFrame !== 0) return;
  const tick = (now: number) => {
    motionFrame = now < motionEnd ? window.requestAnimationFrame(tick) : 0;
    for (const listener of motionListeners) listener();
  };
  motionFrame = window.requestAnimationFrame(tick);
}
