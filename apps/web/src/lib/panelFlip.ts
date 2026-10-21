import { observeResize } from "./observeResize";

/**
 * Panel open and close without per-frame layout. A toggle lays the page out
 * once at its final size, and everything marked with `data-panel-flip` glides
 * from where it was to its new place on a transform (FLIP), the sliding panel
 * included: `start` for content held to the left edge, `center` (the default)
 * for centered columns, `end` for content held to the right edge. A marked
 * element inside another marked element plays only its difference from that
 * ancestor, so a right-anchored card inside a centered column stays still.
 *
 * Mark the content, never the pane: a transform makes the pane the containing
 * block of its `position: fixed` controls, and they jump with it.
 *
 * Every glide of a toggle shares one duration and curve and starts on the same
 * frame: the first frame after the one that committed the layout. The commit
 * frame is the expensive one (the render, the layout at the new size, the
 * resize observers' re-render), and an animation started inside it is
 * already a third of the way along by the time that frame paints. Starting
 * them one frame later costs a frame nobody sees (the content is drawn where
 * it was) and makes the first visible frame the first one of the motion.
 *
 * Contained motion (`contain`) keeps content inside the window: a column that
 * resizes with the pane reflows once, at its final width, and glides by its
 * start edge, so its text keeps its left edge and only the line endings
 * change. Centred content that resizes (the draft hero and its composer) adds
 * `data-panel-flip-contain="window"`: it keeps its center where it was, and
 * only stays inside the window.
 *
 * A marked element that was not there before (an opening panel) names the
 * window edge it comes in from with `data-panel-flip-enter="start" | "end"`.
 * One whose final state hides it (a closed sidebar, `visibility: hidden`)
 * adds `data-panel-flip-visible` to stay visible until it has left.
 */
export type PanelFlipAnchor = "start" | "center" | "end";

/** Matches ease-standard in index.css. */
export const PANEL_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * A toggle's glide begins one frame after its layout commits, so a motion of
 * durationMs ends this much later than the commit at the earliest. Timers
 * that wait for the motion (unmounting a closed panel) add it.
 */
export const PANEL_MOTION_SETTLE_MS = 50;

const PANEL_FLIP_SELECTOR = "[data-panel-flip]";
const PANEL_FLIP_COLUMN_SELECTOR = "[data-panel-flip-column]";
const PANEL_FLIP_ENTER_SELECTOR = "[data-panel-flip-enter]";
const PANEL_FLIP_WINDOW_CONTAIN = "window";
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
  /** Contained, keep it inside these bounds (the window) instead of its two spans. */
  readonly within?: HorizontalBounds;
}

export interface PanelFlipSnapshot {
  /** Where marked content was captured; elements entering since are found here. */
  readonly root: ParentNode;
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
   * Keep each element inside the window. Content of a fixed width glides by
   * its anchor. A column that resizes with the pane glides by its start edge:
   * its text keeps its left edge, and the pane clips whatever reaches past
   * the window while it moves. Content contained to the window keeps its
   * center as far as the window allows.
   */
  readonly contain?: boolean;
}

function containOffset(entry: PanelFlipMeasurement): number {
  const { before, after, within, anchor } = entry;
  if (within) {
    const offset = anchorX(before, anchor) - anchorX(after, anchor);
    const low = within.left - after.left;
    const high = within.right - after.right;
    return low <= high ? Math.min(Math.max(offset, low), high) : 0;
  }
  const resized = Math.abs(before.right - before.left - (after.right - after.left)) >= 0.5;
  return anchorX(before, resized ? "start" : anchor) - anchorX(after, resized ? "start" : anchor);
}

/** The starting translateX for each element; 0 means it does not move. */
export function resolvePanelFlipOffsets(
  measurements: readonly PanelFlipMeasurement[],
  options: PanelFlipOptions = {},
): number[] {
  const deltas = measurements.map((entry) =>
    options.contain
      ? containOffset(entry)
      : anchorX(entry.before, entry.anchor) - anchorX(entry.after, entry.anchor),
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

/**
 * Where marked content is drawn. A full-width pane that centres a capped
 * column marks a probe with `data-panel-flip-column`: the column's width,
 * with the pane's gutter as its start padding. The bounds are then the
 * column as laid out, capped or filling the pane inside its gutters, so
 * containment glides a capped column by its center and a column that fills
 * the pane by its start edge, which is where its text begins.
 */
function readBounds(element: HTMLElement): HorizontalBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const column = element.querySelector<HTMLElement>(PANEL_FLIP_COLUMN_SELECTOR);
  if (!column || column.parentElement?.closest(PANEL_FLIP_SELECTOR) !== element) {
    return { left: rect.left, right: rect.right };
  }
  const styles = getComputedStyle(column);
  const gutter = Number.parseFloat(styles.paddingLeft) || 0;
  const columnWidth = Number.parseFloat(styles.width) || column.offsetWidth;
  const halfWidth = Math.max(Math.min(rect.width - 2 * gutter, columnWidth), 0) / 2;
  const center = (rect.left + rect.right) / 2;
  return { left: center - halfWidth, right: center + halfWidth };
}

/** Where an element that was not captured comes in from: just past the window edge it names. */
function readEnterBounds(element: HTMLElement, after: HorizontalBounds): HorizontalBounds | null {
  const edge = element.dataset.panelFlipEnter;
  const width = after.right - after.left;
  if (edge === "end") {
    const windowRight = document.documentElement.clientWidth;
    return { left: windowRight, right: windowRight + width };
  }
  if (edge === "start") return { left: -width, right: 0 };
  return null;
}

/** Records where marked content inside root sits now. Call before the layout changes. */
export function capturePanelFlip(root: ParentNode | null): PanelFlipSnapshot | null {
  if (!root) return null;
  const entries: Array<PanelFlipSnapshot["entries"][number]> = [];
  for (const element of root.querySelectorAll<HTMLElement>(PANEL_FLIP_SELECTOR)) {
    const bounds = readBounds(element);
    if (bounds) entries.push({ element, bounds });
  }
  return { root, entries };
}

/**
 * Glides captured content from its old place to the committed layout. Call it
 * from a layout effect: it inverts there, in the task that committed the new
 * layout, so the first frame that paints it already draws marked content where
 * it was; the glide itself starts on the next frame. Size-derived positions
 * (the mini player, the canvas lanes) re-render in this frame's resize step,
 * so content is measured again there and retargeted.
 */
export function playPanelFlip(
  snapshot: PanelFlipSnapshot,
  durationMs: number,
  options: PanelFlipOptions = {},
): void {
  flipPanelContent(snapshot, durationMs, false, options);
  notifyPanelMotion(durationMs + PANEL_MOTION_SETTLE_MS);
  retargetAfterResize(snapshot, durationMs, options);
}

/**
 * Re-aims a flip that is already playing at the layout as it is now, keeping
 * the time it has run. For a second commit that moves the same content again
 * (the list column stepping aside for the right panel): the content keeps
 * gliding from where it was last painted, in one motion, instead of a second
 * flip restarting from a layout that was never shown. Call it after the other
 * flip has played: its resize retarget then also lands after that flip's,
 * since observers deliver in the order they were created.
 */
export function retargetPanelFlip(
  snapshot: PanelFlipSnapshot,
  durationMs: number,
  options: PanelFlipOptions = {},
): void {
  flipPanelContent(snapshot, durationMs, true, options);
  notifyPanelMotion(durationMs + PANEL_MOTION_SETTLE_MS);
  retargetAfterResize(snapshot, durationMs, options);
}

/** One more aim once the frame's resize step has re-rendered size-derived positions. */
function retargetAfterResize(
  snapshot: PanelFlipSnapshot,
  durationMs: number,
  options: PanelFlipOptions,
): void {
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

/**
 * Glides created in one task start together on the next frame. Each holds its
 * first keyframe (content drawn where it was) until then, so the commit frame
 * paints the old picture whatever it costs, and the motion's first frame is
 * one that paints on time.
 */
const pendingStart = new Set<Animation>();
let startFrame = 0;

function startNextFrame(animation: Animation): void {
  animation.pause();
  pendingStart.add(animation);
  if (startFrame !== 0) return;
  startFrame = window.requestAnimationFrame(() => {
    startFrame = 0;
    for (const pending of pendingStart) {
      // A glide retargeted or cancelled since has been replaced.
      if (pending.playState === "paused") pending.play();
    }
    pendingStart.clear();
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
  // a retarget of this same flip resumes at the time it had reached, and one
  // still waiting for its first frame keeps waiting.
  const elapsedByElement = new Map<HTMLElement, number>();
  const waitingElements = new Set<HTMLElement>();
  // Hold content that keeps visible before anything below reads style, so its
  // hidden final state and the hold resolve in the same style pass instead of
  // restyling its subtree hidden and then visible again (holdVisibleUntilDone).
  const heldEarly: HTMLElement[] = [];
  for (const { element } of snapshot.entries) {
    if (element.dataset.panelFlipVisible === undefined || element.style.visibility === "visible") {
      continue;
    }
    element.style.visibility = "visible";
    heldEarly.push(element);
  }
  for (const { element } of snapshot.entries) {
    for (const animation of element.getAnimations()) {
      if (animation.id !== PANEL_FLIP_ANIMATION_ID) continue;
      if (resume) {
        if (pendingStart.has(animation)) waitingElements.add(element);
        if (typeof animation.currentTime === "number") {
          elapsedByElement.set(element, animation.currentTime);
        }
      }
      pendingStart.delete(animation);
      animation.cancel();
    }
  }
  const elements: HTMLElement[] = [];
  const measurements: PanelFlipMeasurement[] = [];
  const indexByElement = new Map<HTMLElement, number>();
  const measure = (element: HTMLElement, before: HorizontalBounds | null) => {
    // Content that stopped being marked (a panel leaving maximized) snaps.
    if (!element.isConnected || !element.matches(PANEL_FLIP_SELECTOR)) return;
    const after = readBounds(element);
    if (!after) return;
    const from = before ?? readEnterBounds(element, after);
    if (!from) return;
    indexByElement.set(element, elements.length);
    elements.push(element);
    measurements.push({
      anchor: readAnchor(element),
      before: from,
      after,
      parent: null,
      ...(element.dataset.panelFlipContain === PANEL_FLIP_WINDOW_CONTAIN
        ? { within: { left: 0, right: document.documentElement.clientWidth } }
        : {}),
    });
  };
  for (const { element, bounds } of snapshot.entries) measure(element, bounds);
  // Marked content mounted since the capture (an opening panel) comes in from
  // the window edge it names. Snapshot entries keep document order; entering
  // elements follow, so an entering element's ancestor is indexed first too.
  for (const element of snapshot.root.querySelectorAll<HTMLElement>(PANEL_FLIP_ENTER_SELECTOR)) {
    if (!indexByElement.has(element)) measure(element, null);
  }
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
    if (element.dataset.panelFlipVisible !== undefined) holdVisibleUntilDone(element, animation);
    const elapsed = elapsedByElement.get(element);
    if (elapsed === undefined || waitingElements.has(element)) {
      startNextFrame(animation);
    } else {
      animation.currentTime = elapsed;
    }
  });
  // Content that ended up not gliding (no offset) and has no glide holding it snaps.
  for (const element of heldEarly) {
    if (!visibilityHolds.has(element)) element.style.removeProperty("visibility");
  }
}

/**
 * Content whose final state hides it (`data-panel-flip-visible`) stays visible
 * through an inline style while its glide plays, not a `visibility` keyframe:
 * `visibility` is inherited, so animating it restyles the whole document on
 * every start, retarget and finish of the glide (five full style passes per
 * sidebar close instead of three). The hold is released by whichever glide is
 * current when it ends.
 */
const visibilityHolds = new Map<HTMLElement, Animation>();

function holdVisibleUntilDone(element: HTMLElement, animation: Animation): void {
  visibilityHolds.set(element, animation);
  element.style.visibility = "visible";
  const release = () => {
    if (visibilityHolds.get(element) !== animation) return;
    visibilityHolds.delete(element);
    element.style.removeProperty("visibility");
  };
  animation.finished.then(release, release);
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
