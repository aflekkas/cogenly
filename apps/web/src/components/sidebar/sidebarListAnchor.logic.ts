export type ScrollBox = {
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

/**
 * The scrollTop a sidebar list returns to: its remembered position, clamped
 * to the content it has now. Lists read down from the search dock, so a list
 * never seen before (no position) opens on its first rows.
 */
export function restoredScrollTop(remembered: number | undefined, box: ScrollBox): number {
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  return Math.min(Math.max(0, remembered ?? 0), max);
}
