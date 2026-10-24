/**
 * Bounded thread warm-up shared by clients: an LRU of recently left thread
 * snapshots and an intent prefetcher that keeps a few hovered or focused
 * threads loading through their normal state atoms. Neither keeps its own copy
 * of thread data; both only decide which existing subscriptions stay open.
 */

/** Recently left threads whose in-memory snapshot is kept for an instant return. */
export const RETAINED_THREAD_SNAPSHOT_LIMIT = 12;
/** Threads a pointer or focus may keep loading at once, beyond the open one. */
export const THREAD_INTENT_PREFETCH_LIMIT = 3;
/** How long a prefetched thread stays subscribed without being opened. */
export const THREAD_INTENT_PREFETCH_IDLE_MS = 15_000;
/** The pointer has to rest on a row this long before it counts as intent. */
export const THREAD_INTENT_DWELL_MS = 100;
/** A pointer that arrives on a row within this long of a scroll is scrolling past. */
export const THREAD_INTENT_SCROLL_QUIET_MS = 150;

/**
 * Moves `key` to the most recent end of a bounded list and reports what fell
 * off the oldest end. The input is never mutated.
 */
export function touchBoundedKeys(
  keys: ReadonlyArray<string>,
  key: string,
  capacity: number,
): { readonly keys: ReadonlyArray<string>; readonly evicted: ReadonlyArray<string> } {
  const next = keys.filter((existing) => existing !== key);
  next.push(key);
  const overflow = Math.max(0, next.length - Math.max(0, capacity));
  return { keys: next.slice(overflow), evicted: next.slice(0, overflow) };
}

/**
 * Caps how many closed threads keep their in-memory snapshot. `closed` puts a
 * thread's cache at the recent end; the oldest closed caches beyond
 * `capacity` are handed to `drop` so the next open resumes from the persisted
 * cache instead. A thread open again when it falls off keeps its snapshot,
 * since it is live, and rejoins the list when it closes.
 */
export function createRetainedSnapshotSet<C>(capacity: number, drop: (cache: C) => void) {
  let order: ReadonlyArray<string> = [];
  const caches = new Map<string, C>();
  const open = new Set<string>();
  return {
    opened: (key: string) => {
      open.add(key);
    },
    closed: (key: string, cache: C) => {
      open.delete(key);
      const touched = touchBoundedKeys(order, key, capacity);
      order = touched.keys;
      caches.set(key, cache);
      for (const evicted of touched.evicted) {
        const stale = caches.get(evicted);
        caches.delete(evicted);
        if (stale !== undefined && !open.has(evicted)) drop(stale);
      }
    },
    /** Closed keys still holding a snapshot, oldest first. */
    keys: (): ReadonlyArray<string> => order,
  };
}

/**
 * Whether a pointer arriving on a thread row may start the dwell timer. Touch
 * has no hover, and a row that slid under a still pointer during a scroll is
 * not one the user is reaching for.
 */
export function canStartThreadIntent(input: {
  readonly pointerType: string;
  readonly now: number;
  readonly lastScrollAt: number | null;
}): boolean {
  if (input.pointerType === "touch") return false;
  return (
    input.lastScrollAt === null || input.now - input.lastScrollAt >= THREAD_INTENT_SCROLL_QUIET_MS
  );
}

/** Whether a dwell that started at `startedAt` still counts when its timer fires. */
export function shouldCommitThreadIntent(input: {
  readonly startedAt: number;
  readonly lastScrollAt: number | null;
}): boolean {
  return input.lastScrollAt === null || input.lastScrollAt < input.startedAt;
}

export interface ThreadPrefetcher {
  /** Starts (or refreshes) keeping `key` loaded. Repeat calls share one mount. */
  readonly prefetch: (key: string) => void;
  /** Stops keeping `key` loaded. The thread's own consumers are unaffected. */
  readonly release: (key: string) => void;
  readonly releaseAll: () => void;
  /** Prefetched keys, oldest first. */
  readonly keys: () => ReadonlyArray<string>;
}

/**
 * Keeps at most `capacity` threads mounted on intent. Mounting the thread's
 * state atom is the prefetch: it runs the same cache read, bounded snapshot
 * request and resumable subscription the route would. Releasing the mount
 * closes that scope, which interrupts a request still in flight. A key is
 * released when newer intent pushes it out or after `idleReleaseMs` without
 * being touched again.
 */
export function createThreadPrefetcher(input: {
  readonly capacity: number;
  readonly idleReleaseMs: number;
  readonly mount: (key: string) => () => void;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
}): ThreadPrefetcher {
  let order: ReadonlyArray<string> = [];
  const entries = new Map<string, { readonly unmount: () => void; cancelIdle: () => void }>();

  const release = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    order = order.filter((existing) => existing !== key);
    entry.cancelIdle();
    entry.unmount();
  };

  const prefetch = (key: string) => {
    if (input.capacity <= 0) return;
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { unmount: input.mount(key), cancelIdle: () => {} };
      entries.set(key, entry);
    } else {
      entry.cancelIdle();
    }
    entry.cancelIdle = input.schedule(() => release(key), input.idleReleaseMs);
    const touched = touchBoundedKeys(order, key, input.capacity);
    order = touched.keys;
    for (const evicted of touched.evicted) {
      const stale = entries.get(evicted);
      if (stale === undefined) continue;
      entries.delete(evicted);
      stale.cancelIdle();
      stale.unmount();
    }
  };

  return {
    prefetch,
    release,
    releaseAll: () => {
      for (const key of [...order]) release(key);
    },
    keys: () => order,
  };
}
