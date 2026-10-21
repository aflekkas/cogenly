import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  limitAutoResumeUpdate,
  limitRecoveryCommand,
  limitRecoveryStatus,
} from "./UsageLimitRecoveryWorker.ts";

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
