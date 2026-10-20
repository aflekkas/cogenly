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
export const PANEL_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** A panel leaving moves quicker than one arriving (Sidebar mirrors it in CSS: 0.7x). */
export const PANEL_EXIT_DURATION_SCALE = 0.7;

const PANEL_FLIP_SELECTOR = "[data-panel-flip]";
const PANEL_FLIP_COLUMN_SELECTOR = "[data-panel-flip-column]";
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

export interface PanelFlipOptions {
  /**
   * Keep each element inside the span it covered before and after, and over
   * the part both share. A column that widens or narrows with the pane then
   * never starts past the window edge or pulls away from the edge that stays
   * put; content of a fixed width still glides by its anchor.
   */
  readonly contain?: boolean;
}

function containOffset(entry: PanelFlipMeasurement, offset: number): number {
  const { before, after } = entry;
  // Within the union of both spans: never drawn where it was not, before or after.
  const unionLow = Math.min(before.left, after.left) - after.left;
  const unionHigh = Math.max(before.right, after.right) - after.right;
  // Over the shared span: no gap opens where it was drawn in both layouts.
  const low = Math.max(unionLow, Math.min(before.right, after.right) - after.right);
  const high = Math.min(unionHigh, Math.max(before.left, after.left) - after.left);
  return low <= high
    ? Math.min(Math.max(offset, low), high)
    : Math.min(Math.max(offset, unionLow), unionHigh);
}

/** The starting translateX for each element; 0 means it does not move. */
export function resolvePanelFlipOffsets(
  measurements: readonly PanelFlipMeasurement[],
  options: PanelFlipOptions = {},
): number[] {
  const deltas = measurements.map((entry) => {
    const delta = anchorX(entry.before, entry.anchor) - anchorX(entry.after, entry.anchor);
    return options.contain ? containOffset(entry, delta) : delta;
  });
  return measurements.map((entry, index) => {
    const offset = deltas[index]! - (entry.parent === null ? 0 : deltas[entry.parent]!);
    return Math.abs(offset) < 0.5 ? 0 : offset;
  });
}

function readAnchor(element: HTMLElement): PanelFlipAnchor {
  const anchor = element.dataset.panelFlip;
  return anchor === "start" || anchor === "end" ? anchor : "center";
}

/**
 * Where marked content is drawn. A full-width pane that centres a capped
 * column marks a probe of the column's width with `data-panel-flip-column`;
 * its bounds are then the centred column, so containment glides a capped
 * column by its center and holds a column that fills the pane.
 */
function readBounds(element: HTMLElement): HorizontalBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const column = element.querySelector<HTMLElement>(PANEL_FLIP_COLUMN_SELECTOR);
  if (!column || column.parentElement?.closest(PANEL_FLIP_SELECTOR) !== element) {
    return { left: rect.left, right: rect.right };
  }
  const halfWidth = Math.min(rect.width, column.offsetWidth) / 2;
  const center = (rect.left + rect.right) / 2;
  return { left: center - halfWidth, right: center + halfWidth };
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
 * from a layout effect: it inverts there, in the task that committed the new
 * layout, so the first frame that paints it already draws marked content where
 * it was. An animation started later in the frame (a ResizeObserver callback)
 * lands a frame late, and that frame flashes the final place. Size-derived
 * positions (the mini player, the canvas lanes) re-render in this frame's
 * resize step, so content is measured again there and retargeted, keeping
 * the time the glide has run.
 */
export function playPanelFlip(
  snapshot: PanelFlipSnapshot,
  durationMs: number,
  options: PanelFlipOptions = {},
): void {
  flipPanelContent(snapshot, durationMs, false, options);
  notifyPanelMotion(durationMs);
  let retargeted = false;
  const stopObserving = observeResize(document.documentElement, () => {
    if (retargeted) return;
    retargeted = true;
    // Resize callbacks share one flushSync; the microtask runs after it commits.
    queueMicrotask(() => {
      stopObserving();
      flipPanelContent(snapshot, durationMs, true, options);
    });
  });
}

function flipPanelContent(
  snapshot: PanelFlipSnapshot,
  durationMs: number,
  resume: boolean,
  options: PanelFlipOptions,
): void {
  // Settle a running flip and read where layout puts content now. The snapshot
  // holds where it was drawn, so an interrupted flip starts over from there;
  // a retarget of this same flip resumes at the time it had reached.
  const elapsedByElement = new Map<HTMLElement, number>();
  for (const { element } of snapshot.entries) {
    for (const animation of element.getAnimations()) {
      if (animation.id !== PANEL_FLIP_ANIMATION_ID) continue;
      if (resume && typeof animation.currentTime === "number") {
        elapsedByElement.set(element, animation.currentTime);
      }
      animation.cancel();
    }
  }
  const elements: HTMLElement[] = [];
  const measurements: PanelFlipMeasurement[] = [];
  const indexByElement = new Map<HTMLElement, number>();
  for (const { element, bounds } of snapshot.entries) {
    // Content that stopped being marked (a panel leaving maximized) snaps.
    if (!element.isConnected || !element.matches(PANEL_FLIP_SELECTOR)) continue;
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
  resolvePanelFlipOffsets(resolved, options).forEach((offset, index) => {
    if (offset === 0) return;
    const element = elements[index]!;
    const animation = element.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
      { duration: durationMs, easing: PANEL_MOTION_EASING },
    );
    animation.id = PANEL_FLIP_ANIMATION_ID;
    const elapsed = elapsedByElement.get(element);
    if (elapsed !== undefined) animation.currentTime = elapsed;
  });
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
