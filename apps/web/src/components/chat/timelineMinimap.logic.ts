import { resolveTimelineMinimapTopPercent } from "./MessagesTimeline.logic";

/**
 * Closest two drawn marks may sit on the rail. Denser threads aggregate
 * neighbouring messages into one mark, so the rail never turns into a solid
 * striped bar and the DOM stays bounded by the rail's height, not the thread's.
 */
export const TIMELINE_MINIMAP_MIN_MARK_SPACING_PX = 6;

/** Marks drawn before the rail has been measured once. */
const TIMELINE_MINIMAP_UNMEASURED_MARK_BUDGET = 48;

/** The reading line, as a fraction of the viewport from its top. */
const TIMELINE_MINIMAP_READING_LINE = 1 / 3;

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
 * The message being read: the last one that starts above the reading line a
 * third of the way down the viewport. Scrolled to the end, it is the last
 * message, even when that one is too short to reach the line.
 */
export function resolveTimelineMinimapCurrentIndex(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): number | null {
  const readingLine =
    input.scrollTop + (input.scrollBottom - input.scrollTop) * TIMELINE_MINIMAP_READING_LINE;
  let current: number | null = null;
  let firstInView: number | null = null;
  let last: { readonly index: number; readonly bottom: number } | null = null;
  for (const [index, item] of input.itemBounds.entries()) {
    if (item.top === null) continue;
    if (item.top <= readingLine) current = index;
    else if (firstInView === null && item.top < input.scrollBottom) firstInView = index;
    last = { index, bottom: item.top + Math.max(1, item.height ?? 1) };
  }
  if (last !== null && last.bottom <= input.scrollBottom) return last.index;
  return current ?? firstInView;
}

/**
 * The one mark drawn bright: the hovered or focused one while the pointer is
 * on the rail, else the one holding the message being read.
 */
export function resolveTimelineMinimapHighlightOrdinal(
  marks: ReadonlyArray<TimelineMinimapMark>,
  input: { readonly hoverIndex: number | null; readonly currentIndex: number | null },
): number | null {
  const index = input.hoverIndex ?? input.currentIndex;
  return index === null ? null : resolveTimelineMinimapMarkOrdinal(marks, index);
}
