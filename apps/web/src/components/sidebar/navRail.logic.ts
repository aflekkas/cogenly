/** Rail width in px: centers its icons under the titlebar's sidebar toggle. */
export const NAV_RAIL_WIDTH_PX = 54;

/**
 * Roving focus for a vertical tablist: the index the key moves to, or null
 * when the key does not navigate. Wraps at both ends.
 */
export function resolveVerticalTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
