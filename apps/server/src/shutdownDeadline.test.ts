import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHILD_SHUTDOWN_GRACE_MS,
  LAUNCHER_SHUTDOWN_GRACE_MS,
  SERVER_SHUTDOWN_GRACE_MS,
  SERVICE_STOP_TIMEOUT_SECONDS,
  ShutdownDeadline,
} from "./shutdownDeadline.ts";

afterEach(() => vi.useRealTimers());

describe("process shutdown deadline", () => {
  it("forces exit even while graceful work never settles, without extending on another signal", async () => {
    vi.useFakeTimers();
    const exited = Promise.withResolvers<string>();
    const deadline = new ShutdownDeadline(LAUNCHER_SHUTDOWN_GRACE_MS, () =>
      exited.resolve("forced"),
    );
    const blockedShutdown = new Promise<string>(() => {});
    deadline.start();
    await vi.advanceTimersByTimeAsync(LAUNCHER_SHUTDOWN_GRACE_MS - 1);
    deadline.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.race([blockedShutdown, exited.promise])).toBe("forced");
    deadline.dispose();
  });

  it("disarms the fallback when graceful shutdown completes", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const deadline = new ShutdownDeadline(SERVER_SHUTDOWN_GRACE_MS, forceExit);
    deadline.start();
    deadline.dispose();
    await vi.advanceTimersByTimeAsync(LAUNCHER_SHUTDOWN_GRACE_MS);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("leaves time for the child, launcher, and service manager to exit in order", () => {
    expect(SERVER_SHUTDOWN_GRACE_MS).toBeLessThan(CHILD_SHUTDOWN_GRACE_MS);
    expect(CHILD_SHUTDOWN_GRACE_MS).toBeLessThan(LAUNCHER_SHUTDOWN_GRACE_MS);
    expect(LAUNCHER_SHUTDOWN_GRACE_MS).toBeLessThan(SERVICE_STOP_TIMEOUT_SECONDS * 1000);
  });
});
