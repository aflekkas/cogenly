import { resolveTimelineMinimapTopPercent } from "./MessagesTimeline.logic";

/**
 * Closest two drawn marks may sit on the rail. Denser threads aggregate
 * neighbouring messages into one mark, so the rail never turns into a solid
 * striped bar and the DOM stays bounded by the rail's height, not the thread's.
 */
export const TIMELINE_MINIMAP_MIN_MARK_SPACING_PX = 6;

/** Marks drawn before the rail has been measured once. */
const TIMELINE_MINIMAP_UNMEASURED_MARK_BUDGET = 48;

/** Half the viewport window's minimum height, so a single turn still reads. */
const TIMELINE_MINIMAP_WINDOW_PAD_PX = 4;

export interface TimelineMinimapMark {
  /** Bucket ordinal: stable while the thread grows, so marks are not remounted. */
  readonly key: number;
  /** The message a hover or click on this mark resolves to. */
  readonly itemIndex: number;
  readonly startIndex: number;
  /** Inclusive. */
  readonly endIndex: number;
  /** Rail position, percent of the rail's height. */
  readonly topPercent: number;
  /** The bucket holds a message the user typed, not only agent or automation sends. */
  readonly typed: boolean;
}

export interface TimelineMinimapViewportWindow {
  readonly start: number;
  readonly end: number;
}

export function resolveTimelineMinimapMarkBudget(railHeightPx: number): number {
  if (!Number.isFinite(railHeightPx) || railHeightPx <= 0) {
    return TIMELINE_MINIMAP_UNMEASURED_MARK_BUDGET;
  }
  return Math.max(2, Math.floor(railHeightPx / TIMELINE_MINIMAP_MIN_MARK_SPACING_PX) + 1);
}

/**
 * One mark per message while they fit; past that, equal index buckets, each
 * drawn at its centre and represented by its first typed message (else its
 * first message). Typed messages are what a reader navigates by, so a bucket of
 * only agent-sent messages stays a faint mark.
 */
export function buildTimelineMinimapMarks(
  items: ReadonlyArray<{ readonly typed: boolean }>,
  budget: number,
): TimelineMinimapMark[] {
  const itemCount = items.length;
  if (itemCount === 0) return [];
  const markCount = Math.min(itemCount, Math.max(1, Math.floor(budget)));
  const marks: TimelineMinimapMark[] = [];
  for (let bucket = 0; bucket < markCount; bucket += 1) {
    const startIndex = Math.floor((bucket * itemCount) / markCount);
    const endIndex = Math.floor(((bucket + 1) * itemCount) / markCount) - 1;
    let itemIndex = startIndex;
    let typed = false;
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (items[index]?.typed) {
        itemIndex = index;
        typed = true;
        break;
      }
    }
    marks.push({
      key: bucket,
      itemIndex,
      startIndex,
      endIndex,
      topPercent: resolveTimelineMinimapTopPercent((startIndex + endIndex) / 2, itemCount),
      typed,
    });
  }
  return marks;
}

/** The mark whose bucket holds `itemIndex`, or null outside the marks. */
export function resolveTimelineMinimapMarkOrdinal(
  marks: ReadonlyArray<TimelineMinimapMark>,
  itemIndex: number,
): number | null {
  let low = 0;
  let high = marks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const mark = marks[middle]!;
    if (itemIndex < mark.startIndex) high = middle - 1;
    else if (itemIndex > mark.endIndex) low = middle + 1;
    else return middle;
  }
  return null;
}

/**
 * The run of messages the viewport shows, first to last. Between messages (deep
 * in a long reply) it collapses onto the message the reader is under.
 */
export function resolveTimelineMinimapViewportWindow(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): TimelineMinimapViewportWindow | null {
  let preceding: number | null = null;
  let first: number | null = null;
  let last: number | null = null;
  for (const [index, item] of input.itemBounds.entries()) {
    if (item.top === null) continue;
    const inView =
      item.top < input.scrollBottom && item.top + Math.max(1, item.height ?? 1) > input.scrollTop;
    if (inView) {
      first ??= index;
      last = index;
    } else if (item.top <= input.scrollTop) {
      preceding = index;
    }
  }
  if (first !== null && last !== null) return { start: first, end: last };
  return preceding === null ? null : { start: preceding, end: preceding };
}

/** Inline geometry for the viewport window, padded so one message still shows. */
export function resolveTimelineMinimapWindowStyle(
  window: TimelineMinimapViewportWindow,
  itemCount: number,
): { readonly top: string; readonly height: string } {
  const top = resolveTimelineMinimapTopPercent(window.start, itemCount);
  const bottom = resolveTimelineMinimapTopPercent(window.end, itemCount);
  return {
    top: `calc(${top}% - ${TIMELINE_MINIMAP_WINDOW_PAD_PX}px)`,
    height: `calc(${bottom - top}% + ${TIMELINE_MINIMAP_WINDOW_PAD_PX * 2}px)`,
  };
}
