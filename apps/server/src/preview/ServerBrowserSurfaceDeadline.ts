// @effect-diagnostics globalTimers:off globalDate:off - Bounds a Promise-based Chrome operation, including its queue wait.
/** A cancelled opener releases its host lock; continuations must check the supplied signal before publishing. */
export async function openSurfaceWithinDeadline<A>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  caller: AbortSignal,
  open: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const controller = new AbortController();
  const signal = AbortSignal.any([caller, controller.signal]);
  const expiresAt = Date.now() + 12_000;
  const timeout = () => controller.abort(new Error("Opening the extension timed out."));
  const timer = setTimeout(timeout, 12_000);
  let aborted: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  const previous = locks.get(key) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(() => {
      if (Date.now() >= expiresAt) timeout();
      signal.throwIfAborted();
      return open(signal);
    });
  const opening = Promise.race([work, cancelled]);
  locks.set(key, opening);
  try {
    return await opening;
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
    if (locks.get(key) === opening) locks.delete(key);
  }
}
