import type { RunAttemptId, RunId } from "@t3tools/contracts";

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * Whether the timeline's real rows extend past the viewport left above the
 * composer. The list's own content length includes the composer inset
 * spacer, so this measures from the last row instead. Unknown row geometry
 * or an unmeasured viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
  readonly disclosures?: {
    readonly runs: ReadonlySet<RunId>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<RunAttemptId>;
    readonly workGroupState: {
      scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
      expandedEntries: Set<string>;
    };
  };
}

/**
 * A wheel event within this gap of the previous one continues the same
 * gesture. Trackpad momentum streams events every frame, so its tail stays
 * inside one gesture.
 */
export const WHEEL_GESTURE_GAP_MS = 120;

export interface WheelGesture {
  readonly startedAt: number;
  readonly lastAt: number;
}

/** The gesture a wheel event at `at` belongs to, given the previous one. */
export function nextWheelGesture(
  gesture: WheelGesture | null,
  at: number,
  gapMs: number = WHEEL_GESTURE_GAP_MS,
): WheelGesture {
  return gesture !== null && at - gesture.lastAt <= gapMs
    ? { startedAt: gesture.startedAt, lastAt: at }
    : { startedAt: at, lastAt: at };
}

/**
 * Whether a wheel event is carried over from a gesture begun before a thread
 * opened: momentum from scrolling the previous thread, which the browser keeps
 * delivering to the same scroller. It is not the user scrolling this thread.
 */
export function isCarriedOverWheel(gesture: WheelGesture | null, threadOpenedAt: number): boolean {
  return gesture !== null && gesture.startedAt < threadOpenedAt;
}

/** Whether carried-over momentum (`isCarriedOverWheel`) is still arriving at `now`. */
export function isCarriedOverWheelActive(
  gesture: WheelGesture | null,
  threadOpenedAt: number,
  now: number,
  gapMs: number = WHEEL_GESTURE_GAP_MS,
): boolean {
  return (
    gesture !== null && isCarriedOverWheel(gesture, threadOpenedAt) && now - gesture.lastAt <= gapMs
  );
}

let currentWheelGesture: WheelGesture | null = null;
let wheelGestureTrackerInstalled = false;

/** Starts tracking wheel gestures document-wide, before any scroller's own listeners run. */
export function ensureWheelGestureTracker() {
  if (wheelGestureTrackerInstalled || typeof document === "undefined") return;
  wheelGestureTrackerInstalled = true;
  document.addEventListener(
    "wheel",
    () => {
      currentWheelGesture = nextWheelGesture(currentWheelGesture, performance.now());
    },
    { capture: true, passive: true },
  );
}

/** The wheel gesture in progress (or last seen); see `isCarriedOverWheel`. */
export function readWheelGesture(): WheelGesture | null {
  return currentWheelGesture;
}

// Scoped thread keys keep separate environments independent. Bound the session cache.
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function readTimelinePosition(threadKey: string) {
  return rememberedTimelinePositions.get(threadKey);
}

export function rememberTimelinePosition(
  threadKey: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
) {
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, {
    ...position,
    atEnd: liveFollowEnabled || position.atEnd,
  });
  if (rememberedTimelinePositions.size > 100) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
}
