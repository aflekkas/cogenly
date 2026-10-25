import { parseScopedThreadKey, scopedThreadKey } from "@cogenly/client-runtime/environment";
import {
  canStartThreadIntent,
  createThreadPrefetcher,
  shouldCommitThreadIntent,
  THREAD_INTENT_DWELL_MS,
  THREAD_INTENT_PREFETCH_IDLE_MS,
  THREAD_INTENT_PREFETCH_LIMIT,
} from "@cogenly/client-runtime/state/threads";
import type { ScopedThreadRef } from "@cogenly/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadStateAtom } from "./threads";

// Mounting the thread's own state atom is the prefetch, so a later open (or
// a second hover) shares that one load and subscription.
const prefetcher = createThreadPrefetcher({
  capacity: THREAD_INTENT_PREFETCH_LIMIT,
  idleReleaseMs: THREAD_INTENT_PREFETCH_IDLE_MS,
  mount: (key) => {
    const ref = parseScopedThreadKey(key);
    if (ref === null) return () => {};
    return appAtomRegistry.mount(environmentThreadStateAtom(ref.environmentId, ref.threadId));
  },
  schedule: (run, delayMs) => {
    const timeout = window.setTimeout(run, delayMs);
    return () => window.clearTimeout(timeout);
  },
});

/** Starts loading a thread the user is about to open. */
export function prefetchThread(threadRef: ScopedThreadRef): void {
  prefetcher.prefetch(scopedThreadKey(threadRef));
}

// The last wheel or touch scroll anywhere, so a row that slides under a still
// pointer is not mistaken for one the user reached for. Programmatic scrolls
// (a streaming timeline following its end) do not count.
let lastScrollAt: number | null = null;
let scrollTrackingInstalled = false;
function trackUserScroll(): void {
  if (scrollTrackingInstalled || typeof window === "undefined") return;
  scrollTrackingInstalled = true;
  const record = () => {
    lastScrollAt = performance.now();
  };
  window.addEventListener("wheel", record, { capture: true, passive: true });
  window.addEventListener("touchmove", record, { capture: true, passive: true });
}

/**
 * Dwell tracking for one row: `begin` on pointer enter or focus, `cancel` on
 * leave or blur. The thread loads only if the row is still held after
 * THREAD_INTENT_DWELL_MS and no scroll happened meanwhile.
 */
export function createThreadIntent(threadRef: () => ScopedThreadRef | null) {
  let timeout: number | null = null;
  const cancel = () => {
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = null;
  };
  const begin = (pointerType: string | null) => {
    trackUserScroll();
    const now = performance.now();
    if (pointerType !== null && !canStartThreadIntent({ pointerType, now, lastScrollAt })) return;
    cancel();
    timeout = window.setTimeout(() => {
      timeout = null;
      const ref = threadRef();
      if (ref === null) return;
      if (pointerType !== null && !shouldCommitThreadIntent({ startedAt: now, lastScrollAt })) {
        return;
      }
      prefetchThread(ref);
    }, THREAD_INTENT_DWELL_MS);
  };
  return { begin, cancel };
}
