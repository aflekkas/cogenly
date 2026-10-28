// @effect-diagnostics globalTimers:off
// Process-boundary fallback: Effect finalizers can be uninterruptible, so an
// Effect timeout cannot guarantee that the process exits before its manager kills it.
export const SERVER_SHUTDOWN_GRACE_MS = 10_000;
export const CHILD_SHUTDOWN_GRACE_MS = 15_000;
export const LAUNCHER_SHUTDOWN_GRACE_MS = 20_000;
export const SERVICE_STOP_TIMEOUT_SECONDS = 30;

/** Arm once at signal receipt, outside any work queue or resource finalizer. */
export class ShutdownDeadline {
  #timer: ReturnType<typeof setTimeout> | undefined;

  readonly #graceMs: number;
  readonly #forceExit: () => void;

  constructor(graceMs: number, forceExit: () => void) {
    this.#graceMs = graceMs;
    this.#forceExit = forceExit;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(this.#forceExit, this.#graceMs);
    this.#timer.unref();
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
