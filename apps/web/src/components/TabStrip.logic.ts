/**
 * What a tab says about the work behind it: running, finished, or failed.
 * A tab with nothing to report shows no status at all.
 */
export type PanelTabStatus = "running" | "done" | "failed";

/**
 * Where a key moves focus in a horizontal tab strip of `count` tabs, from the
 * tab at `index`: arrows wrap, Home and End jump to the ends. Null for any
 * other key. Focus only; activation is the strip's Enter or Space.
 */
export function tabStripFocusIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** A closed tab's place in the strip while it folds shut. */
export interface LeavingTabSlot {
  readonly id: string;
  /** The tab it followed, so it folds shut in its old place. */
  readonly afterId: string | null;
  readonly width: number;
}

/** How a strip's set of tabs changed: the ids that arrived and the ones that left, with their places. */
export function tabSetChanges(
  previousIds: ReadonlyArray<string>,
  nextIds: ReadonlyArray<string>,
): {
  arrivals: string[];
  departures: Array<{ id: string; afterId: string | null }>;
} {
  const previous = new Set(previousIds);
  const next = new Set(nextIds);
  return {
    arrivals: nextIds.filter((id) => !previous.has(id)),
    departures: previousIds
      .map((id, index) => ({ id, afterId: previousIds[index - 1] ?? null }))
      .filter(({ id }) => !next.has(id)),
  };
}

export type TabStripEntry<T> =
  | { readonly kind: "tab"; readonly item: T; readonly index: number }
  | { readonly kind: "leaving"; readonly slot: LeavingTabSlot };

/**
 * The strip in order: the current tabs, each leaving slot right after the tab
 * (or leaving slot) it followed. A slot with no such neighbour goes at the end.
 */
export function interleaveLeavingTabs<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  leaving: ReadonlyArray<LeavingTabSlot>,
): TabStripEntry<T>[] {
  const entries: TabStripEntry<T>[] = [];
  const placed = new Set<LeavingTabSlot>();
  const place = (afterId: string | null) => {
    for (const slot of leaving) {
      if (placed.has(slot) || slot.afterId !== afterId) continue;
      placed.add(slot);
      entries.push({ kind: "leaving", slot });
      // A run of closed neighbours folds shut together, in order.
      place(slot.id);
    }
  };
  place(null);
  items.forEach((item, index) => {
    entries.push({ kind: "tab", item, index });
    place(item.id);
  });
  for (const slot of leaving) {
    if (!placed.has(slot)) entries.push({ kind: "leaving", slot });
  }
  return entries;
}

/** The DOM id of a strip's tab, for its panel's `aria-labelledby`. */
export function tabStripTabId(prefix: string, index: number): string {
  return `${prefix}-tab-${index}`;
}

/** The DOM id of the panel a strip's selected tab controls. */
export function tabStripPanelId(prefix: string): string {
  return `${prefix}-panel`;
}
