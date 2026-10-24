import { describe, expect, it } from "vite-plus/test";
import {
  MAX_RATE_LIMIT_RETRIES,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type UsageLimitHandoffCandidate,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  decideLimitStop,
  handoffTargets,
  limitAutoResumeUpdate,
  limitRecoveryCommand,
  limitRecoveryStatus,
} from "./UsageLimitRecoveryWorker.ts";
import { rateLimitRetryBackoffMs } from "./UsageLimitStop.ts";

const runId = RunId.make("run-1");
const stoppedAt = DateTime.makeUnsafe("2026-10-21T12:00:00.000Z");
const resetAt = "2026-10-21T15:20:00.000Z";
const beforeReset = Date.parse("2026-10-21T12:00:05.000Z");
const afterReset = Date.parse("2026-10-21T15:20:05.000Z");

function limitedThread(
  overrides: Partial<Parameters<typeof limitRecoveryCommand>[0]> = {},
): Parameters<typeof limitRecoveryCommand>[0] {
  return {
    id: ThreadId.make("thread-1"),
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: runId,
    usageLimitResetAt: resetAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: stoppedAt,
    updatedAt: stoppedAt,
    limitRecovery: null,
    snoozedUntil: null,
    ...overrides,
  };
}

describe("limitRecoveryCommand", () => {
  it("schedules a fresh limit stop to resume at its reset", () => {
    const command = limitRecoveryCommand(limitedThread(), true, beforeReset);
    expect(command).toMatchObject({
      type: "thread.metadata.update",
      limitRecovery: { runId, resetAt, autoResume: true, snooze: false },
    });
  });

  it("leaves an unchosen stop alone when auto-resume and snooze are both off", () => {
    expect(limitRecoveryCommand(limitedThread(), false, beforeReset)).toBeNull();
  });

  it("does not resume a stop whose reset passed before anything was scheduled", () => {
    // An old limited thread must not start working the moment auto-resume turns on.
    expect(limitRecoveryCommand(limitedThread(), true, afterReset)).toBeNull();
    expect(limitRecoveryCommand(limitedThread(), true, afterReset, true)).toBeNull();
  });

  it("continues a scheduled stop once its reset arrives", () => {
    const thread = limitedThread({ limitRecovery: { runId, resetAt, autoResume: true } });
    expect(limitRecoveryCommand(thread, true, beforeReset)).toBeNull();
    expect(limitRecoveryCommand(thread, true, afterReset)).toMatchObject({
      type: "message.dispatch",
      usageLimitContinuationOfRunId: runId,
    });
  });

  it("respects a thread's choice not to resume over the default", () => {
    const thread = limitedThread({ limitRecovery: { runId, resetAt, autoResume: false } });
    expect(limitRecoveryCommand(thread, true, beforeReset)).toBeNull();
    expect(limitRecoveryCommand(thread, true, afterReset)).toBeNull();
  });

  it("never resumes a thread the user stopped, archived or settled", () => {
    const scheduled = { limitRecovery: { runId, resetAt, autoResume: true } };
    // A user stop ends the latest run as interrupted, so it is no longer a limit stop.
    expect(
      limitRecoveryCommand(
        limitedThread({ ...scheduled, status: "interrupted" }),
        true,
        afterReset,
      ),
    ).toBeNull();
    expect(
      limitRecoveryCommand(
        limitedThread({ ...scheduled, archivedAt: stoppedAt }),
        true,
        afterReset,
      ),
    ).toBeNull();
    expect(
      limitRecoveryCommand(
        limitedThread({ ...scheduled, settledOverride: "settled" }),
        true,
        afterReset,
      ),
    ).toBeNull();
  });

  it("records a snooze-only default without scheduling a resume", () => {
    expect(limitRecoveryCommand(limitedThread(), false, beforeReset, true)).toMatchObject({
      type: "thread.metadata.update",
      limitRecovery: { runId, resetAt, autoResume: false, snooze: true },
    });
  });

  it("waits for a snooze that outlasts the reset", () => {
    const thread = limitedThread({
      limitRecovery: { runId, resetAt, autoResume: true },
      snoozedUntil: DateTime.makeUnsafe("2026-10-21T18:00:00.000Z"),
    });
    expect(limitRecoveryCommand(thread, true, afterReset)).toBeNull();
  });
});

describe("limitRecoveryStatus", () => {
  it("reports the default for a stop without a recorded choice while its reset is ahead", () => {
    expect(limitRecoveryStatus(limitedThread(), true, beforeReset)).toEqual({
      resetAt,
      autoResume: true,
    });
    expect(limitRecoveryStatus(limitedThread(), true, afterReset)).toEqual({
      resetAt,
      autoResume: false,
    });
  });

  it("reports the recorded choice for this stop", () => {
    const thread = limitedThread({ limitRecovery: { runId, resetAt, autoResume: false } });
    expect(limitRecoveryStatus(thread, true, beforeReset)).toEqual({ resetAt, autoResume: false });
  });

  it("ignores a choice recorded for an earlier stop", () => {
    const thread = limitedThread({
      limitRecovery: { runId: RunId.make("run-0"), resetAt, autoResume: false },
    });
    expect(limitRecoveryStatus(thread, true, beforeReset)).toEqual({ resetAt, autoResume: true });
  });

  it("is null for threads that are not stopped on a usable limit", () => {
    expect(limitRecoveryStatus(limitedThread({ status: "completed" }), true, beforeReset)).toBe(
      null,
    );
    expect(
      limitRecoveryStatus(limitedThread({ usageLimitResetAt: null }), true, beforeReset),
    ).toBeNull();
    // A reset reported at or before the stop cannot schedule anything.
    expect(
      limitRecoveryStatus(
        limitedThread({ usageLimitResetAt: "2026-10-21T11:00:00.000Z" }),
        true,
        beforeReset,
      ),
    ).toBeNull();
  });
});

describe("decideLimitStop", () => {
  // A 429 with the CLI's backoff: the adapter reports a near reset.
  const rateLimited = (overrides: Partial<Parameters<typeof limitRecoveryCommand>[0]> = {}) =>
    limitedThread({
      usageLimitResetAt: "2026-10-21T12:01:00.000Z",
      limitKind: "rate_limit",
      ...overrides,
    });

  it("retries a short-term rate limit in place, backing off on each retry in a row", () => {
    expect(decideLimitStop(rateLimited())).toEqual({
      type: "arm",
      limitRecovery: {
        runId,
        resetAt: "2026-10-21T12:01:00.000Z",
        autoResume: true,
        retryAttempt: 1,
      },
    });
    // The retry run stopped again: the next retry waits twice as long.
    const previous = {
      runId: RunId.make("run-0"),
      resetAt: "2026-10-21T11:59:00.000Z",
      autoResume: true,
      retryAttempt: 1,
    };
    expect(decideLimitStop(rateLimited({ limitRecovery: previous }))).toEqual({
      type: "arm",
      limitRecovery: {
        runId,
        resetAt: "2026-10-21T12:01:00.000Z",
        autoResume: true,
        retryAttempt: 2,
        retryAt: "2026-10-21T12:02:00.000Z",
      },
    });
  });

  it("stops retrying after the cap: a top-level thread waits for its user", () => {
    const exhausted = {
      runId: RunId.make("run-0"),
      resetAt: "2026-10-21T11:59:00.000Z",
      autoResume: true,
      retryAttempt: MAX_RATE_LIMIT_RETRIES,
    };
    expect(decideLimitStop(rateLimited({ limitRecovery: exhausted }))).toEqual({
      type: "arm",
      limitRecovery: { runId, resetAt: "2026-10-21T12:01:00.000Z", autoResume: false },
    });
  });

  it("hands a delegated child off before giving up, and resumes a spent quota at reset", () => {
    const exhausted = {
      runId: RunId.make("run-0"),
      resetAt: "2026-10-21T11:59:00.000Z",
      autoResume: true,
      retryAttempt: MAX_RATE_LIMIT_RETRIES,
    };
    expect(decideLimitStop(rateLimited({ limitRecovery: exhausted, delegated: true }))).toEqual({
      type: "hand-off-or-resume",
      resume: false,
    });
    expect(decideLimitStop(limitedThread({ limitKind: "quota", delegated: true }))).toEqual({
      type: "hand-off-or-resume",
      resume: true,
    });
    // A legacy stop recorded before the split reads as a quota.
    expect(decideLimitStop(limitedThread())).toEqual({ type: "defaults" });
  });

  it("starts a new chain when the last retry was long ago", () => {
    const stale = {
      runId: RunId.make("run-0"),
      resetAt: "2026-10-21T09:00:00.000Z",
      autoResume: true,
      retryAttempt: MAX_RATE_LIMIT_RETRIES,
    };
    expect(decideLimitStop(rateLimited({ limitRecovery: stale }))).toMatchObject({
      type: "arm",
      limitRecovery: { retryAttempt: 1, autoResume: true },
    });
  });

  it("dispatches a scheduled retry only after its backoff, as a timeline row", () => {
    const thread = rateLimited({
      limitRecovery: {
        runId,
        resetAt: "2026-10-21T12:01:00.000Z",
        autoResume: true,
        retryAttempt: 2,
        retryAt: "2026-10-21T12:02:00.000Z",
      },
    });
    expect(limitRecoveryCommand(thread, false, Date.parse("2026-10-21T12:01:30.000Z"))).toBeNull();
    expect(
      limitRecoveryCommand(thread, false, Date.parse("2026-10-21T12:02:00.000Z")),
    ).toMatchObject({
      type: "message.dispatch",
      usageLimitContinuationOfRunId: runId,
      notification: { summary: `Rate limited: retrying (attempt 2 of ${MAX_RATE_LIMIT_RETRIES})` },
    });
  });
});

describe("handoffTargets", () => {
  const candidate = (instanceId: string) =>
    ({ instanceId: ProviderInstanceId.make(instanceId) }) as UsageLimitHandoffCandidate;
  const ranked = [candidate("claude-personal"), candidate("codex"), candidate("claude-work")];

  it("keeps the shared ranking when no agent chain applies", () => {
    expect(handoffTargets(ranked, null).map((target) => target.candidate.instanceId)).toEqual([
      "claude-personal",
      "codex",
      "claude-work",
    ]);
  });

  it("keeps an agent to its fallback chain, in its order, with each entry's model", () => {
    const chain = [
      { instanceId: ProviderInstanceId.make("claude-uchicago"), model: "claude-opus-5-5" },
      { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      { instanceId: ProviderInstanceId.make("claude-personal"), model: "claude-sonnet-5-5" },
    ];
    expect(
      handoffTargets(ranked, chain).map((target) => [target.candidate.instanceId, target.model]),
    ).toEqual([
      ["codex", "gpt-5"],
      ["claude-personal", "claude-sonnet-5-5"],
    ]);
  });
});

describe("rateLimitRetryBackoffMs", () => {
  it("doubles from a minute and caps at fifteen", () => {
    expect([1, 2, 3, 4, 5, 9].map(rateLimitRetryBackoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
  });
});

describe("limitAutoResumeUpdate", () => {
  it("targets the thread's current stop in both directions", () => {
    expect(limitAutoResumeUpdate(limitedThread(), false)).toEqual({
      runId,
      resetAt,
      autoResume: false,
    });
    expect(limitAutoResumeUpdate(limitedThread(), true)).toEqual({
      runId,
      resetAt,
      autoResume: true,
    });
    expect(limitAutoResumeUpdate(limitedThread({ lastErrorClass: null }), true)).toBeNull();
  });
});
