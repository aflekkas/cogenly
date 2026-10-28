import { type PreviewEvent, ThreadId } from "@cogenly/contracts";

/**
 * Whether an event names a tab the desktop's own server wants rendered
 * natively. The server waits for that tab's `<webview>`, so the desktop must
 * render it even when nobody has the thread open.
 */
export function isNativeServerTabEvent(event: PreviewEvent): boolean {
  return (
    (event.type === "opened" || event.type === "navigated") &&
    event.snapshot.runtime === "server" &&
    event.snapshot.serverRendering !== "stream"
  );
}

/** The threads to keep synced after `event`; the same set when nothing changes. */
export function withNativeServerTabThread(
  threads: ReadonlySet<ThreadId>,
  event: PreviewEvent,
): ReadonlySet<ThreadId> {
  const threadId = ThreadId.make(event.threadId);
  if (!isNativeServerTabEvent(event) || threads.has(threadId)) return threads;
  return new Set(threads).add(threadId);
}
