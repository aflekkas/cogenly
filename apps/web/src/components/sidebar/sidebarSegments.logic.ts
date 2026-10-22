import { useEffect, useRef } from "react";

/**
 * A count-bar segment's count, or null while it is not known yet (loading or
 * reconnecting). An unknown count is never treated as empty.
 */
export type SegmentCount = number | null;

const isEmpty = (count: SegmentCount | undefined) => count === 0;

/** Whether a segment can be chosen: anything but a known zero. */
export function isSegmentSelectable(count: SegmentCount): boolean {
  return !isEmpty(count);
}

/**
 * The segment a count bar shows, given the one asked for. A filter never lands
 * on nothing: when the requested segment is empty, the first non-empty segment
 * in bar order (Work: Working, Needs you, Snoozed, Done) takes its place. Only
 * when every segment is empty does the request stand, and the list shows its
 * one quiet empty line.
 */
export function resolveSegmentSelection(
  counts: ReadonlyArray<SegmentCount>,
  requested: number,
): number {
  const clamped = Math.min(Math.max(0, requested), Math.max(0, counts.length - 1));
  if (!isEmpty(counts[clamped])) return clamped;
  const fallback = counts.findIndex((count) => !isEmpty(count));
  return fallback === -1 ? clamped : fallback;
}

/**
 * Whether a fallback should replace the stored choice: only when the chosen
 * segment just ran out (it held something on the previous render), so a
 * filter left empty while the lists were still loading is not overwritten.
 */
export function shouldPersistSegmentFallback(input: {
  readonly requested: number;
  readonly resolved: number;
  readonly previous: { readonly requested: number; readonly count: SegmentCount } | null;
}): boolean {
  const { requested, resolved, previous } = input;
  if (resolved === requested || previous === null || previous.requested !== requested) {
    return false;
  }
  return previous.count === null || previous.count > 0;
}

/**
 * Resolves a count bar's selection (see `resolveSegmentSelection`) and stores
 * the fallback once the chosen filter runs out, so it does not jump back when
 * that filter fills again later.
 */
export function useSegmentSelection(
  counts: ReadonlyArray<SegmentCount>,
  requested: number,
  onFallback: (index: number) => void,
): number {
  const resolved = resolveSegmentSelection(counts, requested);
  const count = counts[requested] ?? 0;
  const previousRef = useRef<{ requested: number; count: SegmentCount } | null>(null);
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { requested, count };
    if (shouldPersistSegmentFallback({ requested, resolved, previous })) {
      onFallbackRef.current(resolved);
    }
  }, [count, requested, resolved]);
  return resolved;
}
