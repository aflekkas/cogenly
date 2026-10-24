/** A row on screen: a queued message, or one that just left and is collapsing. */
export interface QueuedRowSlot<Item> {
  readonly key: string;
  readonly item: Item;
  readonly leaving: boolean;
  /** Arrived after the tray was up, so the row grows in on its own. */
  readonly animateEnter: boolean;
}

/**
 * The rows to draw for the next queue. Rows keep the server order; a row that
 * left stays where it was (after the row it followed) while it collapses, and
 * one that comes back picks up where its collapse was.
 */
export function mergeQueuedRowSlots<Item>(
  previous: ReadonlyArray<QueuedRowSlot<Item>>,
  next: ReadonlyArray<{ readonly key: string; readonly item: Item }>,
): QueuedRowSlot<Item>[] {
  const previousByKey = new Map(previous.map((slot) => [slot.key, slot]));
  const nextKeys = new Set(next.map(({ key }) => key));
  // The first rows of a tray arrive with the tray, which does the growing.
  const trayUp = previous.length > 0;
  const merged: QueuedRowSlot<Item>[] = next.map(({ key, item }) => ({
    key,
    item,
    leaving: false,
    animateEnter: previousByKey.get(key)?.animateEnter ?? trayUp,
  }));
  previous.forEach((slot, index) => {
    if (nextKeys.has(slot.key)) return;
    let insertAt = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const at = merged.findIndex(({ key }) => key === previous[before]!.key);
      if (at !== -1) {
        insertAt = at + 1;
        break;
      }
    }
    merged.splice(insertAt, 0, { ...slot, leaving: true });
  });
  return merged;
}

/**
 * Optimistic cancels still worth tracking: those whose run is still queued.
 * Run ids never return to the queue once cancelled, so a stale id is harmless
 * and the set only needs trimming when nothing is drawing it.
 */
export function retainQueuedCancels<Id>(
  cancelled: ReadonlySet<Id>,
  queuedIds: Iterable<Id>,
): ReadonlySet<Id> {
  if (cancelled.size === 0) return cancelled;
  const queued = new Set(queuedIds);
  const kept = new Set([...cancelled].filter((id) => queued.has(id)));
  return kept.size === cancelled.size ? cancelled : kept;
}

/** The row to move focus to when `removedKey` leaves: the next one, else the previous. */
export function focusKeyAfterRemoval(
  keys: ReadonlyArray<string>,
  removedKey: string,
): string | null {
  const index = keys.indexOf(removedKey);
  if (index === -1) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}
