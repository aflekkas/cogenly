/**
 * Where an arrow key moves focus in a wrapped grid of `count` cells laid out
 * `columns` wide. Home and End go to the ends. Returns null for other keys,
 * and the same index at an edge, so focus never wraps.
 */
export function gridNeighbor(
  index: number,
  key: string,
  count: number,
  columns: number,
): number | null {
  if (count === 0) return null;
  const width = Math.max(1, columns);
  const clamp = (next: number) => Math.min(count - 1, Math.max(0, next));
  switch (key) {
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowDown":
      return index + width < count ? index + width : index;
    case "ArrowUp":
      return index - width >= 0 ? index - width : index;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** How many cells share the first row, from their rendered top offsets. */
export function gridColumnCount(tops: ReadonlyArray<number>): number {
  if (tops.length === 0) return 1;
  const first = tops[0]!;
  let columns = 0;
  for (const top of tops) {
    if (Math.abs(top - first) > 1) break;
    columns += 1;
  }
  return Math.max(1, columns);
}
