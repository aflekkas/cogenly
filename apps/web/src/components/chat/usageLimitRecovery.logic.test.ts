import { RunId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatResetCountdown,
  resolveUsageLimitRecovery,
  usageLimitRecoveryCopy,
  type UsageLimitStop,
} from "./usageLimitRecovery.logic";

const runId = RunId.make("run-1");
const stoppedAt = "2026-10-21T12:00:00.000Z";
const resetAt = "2026-10-21T15:20:00.000Z";
const beforeReset = Date.parse("2026-10-21T13:00:00.000Z");
const afterReset = Date.parse("2026-10-21T15:21:00.000Z");

function stop(overrides: Partial<UsageLimitStop> = {}): UsageLimitStop {
  return { runId, resetAt, stoppedAt, recovery: null, snoozedUntil: null, ...overrides };
}

describe("resolveUsageLimitRecovery", () => {
  it("follows the auto-resume default until the stop records a choice", () => {
    expect(resolveUsageLimitRecovery(stop(), true, beforeReset)).toEqual({
      kind: "scheduled",
      resetAt,
      resumesAt: resetAt,
    });
    expect(resolveUsageLimitRecovery(stop(), false, beforeReset)).toEqual({
      kind: "cancelled",
      resetAt,
    });
  });

  it("waits out a server retry's backoff and says it is retrying", () => {
    const rateLimitReset = "2026-10-21T12:01:00.000Z";
    const retrying = stop({
      resetAt: rateLimitReset,
      recovery: {
        runId,
        resetAt: rateLimitReset,
        autoResume: true,
        retryAttempt: 2,
        retryAt: "2026-10-21T12:02:00.000Z",
      },
    });
    const now = Date.parse("2026-10-21T12:01:30.000Z");
    const state = resolveUsageLimitRecovery(retrying, false, now);
    expect(state).toEqual({
      kind: "scheduled",
      resetAt: rateLimitReset,
      resumesAt: "2026-10-21T12:02:00.000Z",
      retryAttempt: 2,
    });
    expect(usageLimitRecoveryCopy(state, "locale", now).title).toBe(
      "Retrying automatically in under a minute",
    );
  });

  it("lets the recorded choice override the default in both directions", () => {
    const optedOut = stop({ recovery: { runId, resetAt, autoResume: false } });
    expect(resolveUsageLimitRecovery(optedOut, true, beforeReset).kind).toBe("cancelled");
    const optedIn = stop({ recovery: { runId, resetAt, autoResume: true } });
    expect(resolveUsageLimitRecovery(optedIn, false, beforeReset).kind).toBe("scheduled");
  });

  it("ignores a choice made for an earlier stop", () => {
    const stale = stop({ recovery: { runId: RunId.make("run-0"), resetAt, autoResume: false } });
    expect(resolveUsageLimitRecovery(stale, true, beforeReset).kind).toBe("scheduled");
  });

  it("only claims a resume after the reset when one was scheduled", () => {
    const scheduled = stop({ recovery: { runId, resetAt, autoResume: true } });
    expect(resolveUsageLimitRecovery(scheduled, true, afterReset).kind).toBe("resuming");
    // The server never schedules a stop whose reset passed unchosen.
    expect(resolveUsageLimitRecovery(stop(), true, afterReset).kind).toBe("reset-passed");
    const optedOut = stop({ recovery: { runId, resetAt, autoResume: false } });
    expect(resolveUsageLimitRecovery(optedOut, true, afterReset).kind).toBe("reset-passed");
  });

  it("resumes when a snooze that outlasts the reset wakes", () => {
    const snoozedUntil = "2026-10-21T18:00:00.000Z";
    const snoozed = stop({ recovery: { runId, resetAt, autoResume: true }, snoozedUntil });
    expect(resolveUsageLimitRecovery(snoozed, true, afterReset)).toEqual({
      kind: "scheduled",
      resetAt,
      resumesAt: snoozedUntil,
    });
  });

  it("has nothing to schedule without a reset after the stop", () => {
    expect(resolveUsageLimitRecovery(stop({ resetAt: null }), true, beforeReset).kind).toBe(
      "no-reset",
    );
    expect(
      resolveUsageLimitRecovery(stop({ resetAt: "2026-10-21T11:00:00.000Z" }), true, beforeReset)
        .kind,
    ).toBe("no-reset");
  });
});

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");
  it.each([
    [30_000, "in under a minute"],
    [12 * 60_000, "in 12m"],
    [3 * 3_600_000, "in 3h"],
    [3 * 3_600_000 + 20 * 60_000, "in 3h 20m"],
    [2 * 86_400_000 + 4 * 3_600_000, "in 2d 4h"],
  ])("formats %i ms ahead as %s", (deltaMs, label) => {
    expect(formatResetCountdown(now + deltaMs, now)).toBe(label);
  });
});

describe("usageLimitRecoveryCopy", () => {
  it("states the outcome, not the control", () => {
    const scheduled = usageLimitRecoveryCopy(
      { kind: "scheduled", resetAt, resumesAt: resetAt },
      "24-hour",
      beforeReset,
    );
    expect(scheduled.title).toMatch(/^Resumes automatically (at|tomorrow at|on) /);
    expect(scheduled.description).toBe("Usage limit reached. Resets in 2h 20m.");
    const cancelled = usageLimitRecoveryCopy(
      { kind: "cancelled", resetAt },
      "24-hour",
      beforeReset,
    );
    expect(cancelled.title).toBe("Won't resume automatically");
    expect(cancelled.description).toMatch(/, in 2h 20m\.$/);
  });
});
