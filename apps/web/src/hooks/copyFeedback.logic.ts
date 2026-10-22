/** How long a copy control holds its "Copied" feedback before reverting. */
export const COPY_FEEDBACK_MS = 1500;

export type CopyStatus = "idle" | "copied" | "failed";

export type CopyOutcome =
  | { readonly kind: "copied" }
  | { readonly kind: "failed"; error: Error }
  | { readonly kind: "skipped" };

interface CopyFeedbackOptions {
  /** Time before copied or failed reverts to idle. Zero holds the status until the next copy. */
  readonly resetMs: number;
  readonly onStatus: (status: CopyStatus) => void;
}

/**
 * The state machine behind every copy control: idle, then copied (or failed) for `resetMs`, then
 * idle again. A newer copy supersedes an older one still in flight, and a copy that resolves
 * after `dispose` changes nothing.
 */
export function createCopyFeedback(options: CopyFeedbackOptions) {
  let status: CopyStatus = "idle";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestAttempt = 0;
  let disposed = false;
  let resetMs = options.resetMs;
  let onStatus = options.onStatus;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const settle = (next: CopyStatus) => {
    clearTimer();
    if (status !== next) {
      status = next;
      onStatus(next);
    }
    if (resetMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (status === next) {
          status = "idle";
          onStatus("idle");
        }
      }, resetMs);
    }
  };

  return {
    get status() {
      return status;
    },
    configure(next: CopyFeedbackOptions) {
      resetMs = next.resetMs;
      onStatus = next.onStatus;
    },
    /**
     * Runs one copy. `write` resolves false when there was nothing to copy, which leaves the
     * status alone, and rejects when the clipboard refused.
     */
    async run(write: () => Promise<boolean>): Promise<CopyOutcome> {
      const attempt = ++latestAttempt;
      try {
        const didCopy = await write();
        if (!didCopy) return { kind: "skipped" };
        if (!disposed && attempt === latestAttempt) settle("copied");
        return { kind: "copied" };
      } catch (cause) {
        if (!disposed && attempt === latestAttempt) settle("failed");
        return { kind: "failed", error: cause instanceof Error ? cause : new Error(String(cause)) };
      }
    },
    attach() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
