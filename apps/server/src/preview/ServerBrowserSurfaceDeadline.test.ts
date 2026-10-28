import { afterEach, expect, it, vi } from "@effect/vitest";
import { openSurfaceWithinDeadline } from "./ServerBrowserSurfaceDeadline.ts";

afterEach(() => vi.useRealTimers());

it("times out the entire queued open, frees the lock, and prevents late publication", async () => {
  vi.useFakeTimers();
  const locks = new Map<string, Promise<unknown>>();
  const caller = new AbortController();
  const release = Promise.withResolvers<void>();
  const published = vi.fn();
  const work = openSurfaceWithinDeadline(locks, "host", caller.signal, async (signal) => {
    await release.promise;
    signal.throwIfAborted();
    published();
  });
  const failed = expect(work).rejects.toThrow("timed out");
  const queued = vi.fn(async () => "queued");
  const queuedWork = openSurfaceWithinDeadline(locks, "host", caller.signal, queued);
  const queuedFailure = expect(queuedWork).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(12_000);
  await Promise.all([failed, queuedFailure]);
  expect(locks.size).toBe(0);
  expect(queued).not.toHaveBeenCalled();
  await expect(
    openSurfaceWithinDeadline(locks, "host", caller.signal, async () => "next"),
  ).resolves.toBe("next");
  release.resolve();
  await vi.runAllTimersAsync();
  expect(published).not.toHaveBeenCalled();
});

it("interrupts an active opener when the caller cancels", async () => {
  const locks = new Map<string, Promise<unknown>>();
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  const work = openSurfaceWithinDeadline(locks, "host", caller.signal, async () => {
    started.resolve();
    return new Promise<never>(() => {});
  });
  await started.promise;
  const failed = expect(work).rejects.toThrow("caller cancelled");
  caller.abort(new Error("caller cancelled"));
  await failed;
  expect(locks.size).toBe(0);
});
