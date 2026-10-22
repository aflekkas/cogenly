/**
 * The usage-limit stop a thread is in, and the recovery updates that act on
 * it. Pure: the recovery worker, the thread service and the MCP tools share it.
 */
import type {
  OrchestrationV2LimitRecoveryUpdate,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type LimitStopShell = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "usageLimitResetAt"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
>;

/** The thread's current usage-limit stop with a usable reset, or null when it has none. */
function limitStop(thread: LimitStopShell) {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const stoppedMs = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  if (!Number.isFinite(resetMs) || resetMs <= stoppedMs) return null;
  const recovery = thread.limitRecovery;
  return {
    runId: thread.latestRunId,
    resetAt: thread.usageLimitResetAt,
    resetMs,
    recorded:
      recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt
        ? recovery
        : null,
  };
}

/**
 * Whether a thread stopped on a usage limit continues at its reset. A stop
 * without a recorded choice follows the server default, which the sweep
 * applies only while the reset is ahead (see {@link limitRecoveryCommand}).
 */
export function limitRecoveryStatus(
  thread: LimitStopShell,
  autoResumeByDefault: boolean,
  nowMs: number,
): { readonly resetAt: string; readonly autoResume: boolean } | null {
  const stop = limitStop(thread);
  if (stop === null) return null;
  return {
    resetAt: stop.resetAt,
    autoResume: stop.recorded?.autoResume ?? (autoResumeByDefault && stop.resetMs > nowMs),
  };
}

/** The recovery update that turns auto-resume on or off for the thread's current stop. */
export function limitAutoResumeUpdate(
  thread: LimitStopShell,
  autoResume: boolean,
): OrchestrationV2LimitRecoveryUpdate | null {
  const stop = limitStop(thread);
  return stop === null ? null : { runId: stop.runId, resetAt: stop.resetAt, autoResume };
}

/**
 * The recovery update that snoozes the thread until its current stop's reset,
 * or ends that reset-owned snooze. Null when there is no stop with a reset
 * still ahead.
 */
export function limitSnoozeUpdate(
  thread: LimitStopShell,
  snooze: boolean,
  nowMs: number,
): OrchestrationV2LimitRecoveryUpdate | null {
  const stop = limitStop(thread);
  return stop === null || (snooze && stop.resetMs <= nowMs)
    ? null
    : { runId: stop.runId, resetAt: stop.resetAt, snooze };
}

/** True when the thread's snooze is the one its usage-limit reset set. */
export function isLimitResetSnooze(
  thread: LimitStopShell & Pick<OrchestrationV2ThreadShell, "snoozedUntil">,
): boolean {
  const stop = limitStop(thread);
  return (
    stop?.recorded?.snooze === true &&
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) === stop.resetMs
  );
}
