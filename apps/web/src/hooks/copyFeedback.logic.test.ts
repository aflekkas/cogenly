import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { COPY_FEEDBACK_MS, createCopyFeedback, type CopyStatus } from "./copyFeedback.logic";

function setup(resetMs = COPY_FEEDBACK_MS) {
  const seen: CopyStatus[] = [];
  const feedback = createCopyFeedback({ resetMs, onStatus: (status) => seen.push(status) });
  return { feedback, seen };
}

describe("createCopyFeedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds copied until the reset time, then returns to idle", async () => {
    const { feedback, seen } = setup();
    expect(await feedback.run(async () => true)).toEqual({ kind: "copied" });
    expect(feedback.status).toBe("copied");

    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1);
    expect(feedback.status).toBe("copied");
    vi.advanceTimersByTime(1);
    expect(feedback.status).toBe("idle");
    expect(seen).toEqual(["copied", "idle"]);
  });

  it("restarts the hold when copied again", async () => {
    const { feedback, seen } = setup();
    await feedback.run(async () => true);
    vi.advanceTimersByTime(1000);
    await feedback.run(async () => true);
    vi.advanceTimersByTime(1000);
    expect(feedback.status).toBe("copied");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1000);
    expect(feedback.status).toBe("idle");
    expect(seen).toEqual(["copied", "idle"]);
  });

  it("reports a refused write as failed, then reverts", async () => {
    const { feedback, seen } = setup();
    const error = new Error("denied");
    const outcome = await feedback.run(async () => {
      throw error;
    });
    expect(outcome).toEqual({ kind: "failed", error });
    expect(feedback.status).toBe("failed");
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    expect(seen).toEqual(["failed", "idle"]);
  });

  it("wraps a non-Error rejection", async () => {
    const { feedback } = setup();
    const outcome = await feedback.run(() => Promise.reject("nope"));
    expect(outcome.kind === "failed" && outcome.error.message).toBe("nope");
  });

  it("leaves the status alone when there was nothing to copy", async () => {
    const { feedback, seen } = setup();
    expect(await feedback.run(async () => false)).toEqual({ kind: "skipped" });
    expect(seen).toEqual([]);
  });

  it("lets a later copy supersede one still in flight", async () => {
    const { feedback, seen } = setup();
    let release!: (ok: boolean) => void;
    const slow = feedback.run(() => new Promise<boolean>((resolve) => (release = resolve)));
    await feedback.run(async () => {
      throw new Error("later failure");
    });
    release(true);
    await slow;
    expect(feedback.status).toBe("failed");
    expect(seen).toEqual(["failed"]);
  });

  it("holds the status when the reset time is zero", async () => {
    const { feedback } = setup(0);
    await feedback.run(async () => true);
    vi.advanceTimersByTime(60_000);
    expect(feedback.status).toBe("copied");
  });

  it("ignores a copy that lands after dispose, and its timer", async () => {
    const { feedback, seen } = setup();
    await feedback.run(async () => true);
    feedback.dispose();
    vi.advanceTimersByTime(COPY_FEEDBACK_MS);
    await feedback.run(async () => true);
    expect(seen).toEqual(["copied"]);
  });
});
