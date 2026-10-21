/**
 * Whether a context menu (native on desktop, the DOM fallback on web) is up.
 * Surfaces that close on pointer leave, such as the list column's hover peek,
 * stay open while a menu opened from them is showing.
 */
let openCount = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export async function trackContextMenu<T>(menu: Promise<T>): Promise<T> {
  openCount += 1;
  notify();
  try {
    return await menu;
  } finally {
    openCount -= 1;
    notify();
  }
}

export function isContextMenuOpen(): boolean {
  return openCount > 0;
}

export function subscribeContextMenuOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
