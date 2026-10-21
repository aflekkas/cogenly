/** A tab's cap: the width a comfortable title gets. */
export const TAB_MAX_WIDTH = 176;
/** Below this a title is no longer readable; tabs give up their label instead. */
export const TAB_MIN_READABLE_WIDTH = 96;
/** An icon-only tab. */
export const TAB_ICON_WIDTH = 36;
/** gap-0.5 between tabs. */
export const TAB_GAP = 2;

/**
 * Tab widths for a strip of `count` tabs in `available` pixels. Every tab
 * keeps its title until the strip runs out of room; then all shrink evenly,
 * and only once a tab would fall below the readable minimum do the inactive
 * ones become icons, with the selected tab keeping a readable width. The
 * strip scrolls when even that does not fit.
 */
export function resolveTabWidths(count: number, activeIndex: number, available: number): number[] {
  if (count <= 0) return [];
  const room = Math.max(0, available - (count - 1) * TAB_GAP);
  const even = Math.min(TAB_MAX_WIDTH, Math.floor(room / count));
  if (even >= TAB_MIN_READABLE_WIDTH) return Array.from({ length: count }, () => even);
  const keep = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
  const keptWidth = Math.max(
    TAB_MIN_READABLE_WIDTH,
    Math.min(TAB_MAX_WIDTH, room - (count - 1) * TAB_ICON_WIDTH),
  );
  return Array.from({ length: count }, (_, index) => (index === keep ? keptWidth : TAB_ICON_WIDTH));
}
