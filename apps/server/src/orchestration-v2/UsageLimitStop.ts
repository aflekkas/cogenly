/**
 * The usage-limit stop a thread is in, and the recovery updates that act on
 * it. Pure: the recovery worker, the thread service and the MCP tools share it.
 */
import {
  limitRecoveryResumeAt,
  MAX_RATE_LIMIT_RETRIES,
  type OrchestrationV2AppThread,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

/**
 * Prefix of the command a handoff uses to cancel a scheduled resume before it
 * continues the thread elsewhere. That cancel is not the end of a delegated
 * child's recovery, so the parent is not handed the limit as its result.
 */
export const LIMIT_HANDOFF_CANCEL_COMMAND_PREFIX = "limit-handoff-cancel:";

/** Prefix of the message a handoff continues a stopped thread on another instance with. */
export const LIMIT_HANDOFF_COMMAND_PREFIX = "limit-handoff:";

/** Prefix of the command the recovery sweep arms a stop with, before any choice for it. */
export const LIMIT_ARM_COMMAND_PREFIX = "limit-arm:";

export { MAX_RATE_LIMIT_RETRIES };
/** Retries further apart than this start a new chain. */
const RATE_LIMIT_RETRY_CHAIN_MS = 30 * 60_000;

/** Backoff before retry `attempt` (from 1): 1, 2, 4, 8, then 15 minutes. */
export function rateLimitRetryBackoffMs(attempt: number): number {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * The retry a fresh rate-limit stop would be, counting the server's retries of
 * the stops just before it, or null once they are used up.
 */
export function nextRateLimitRetry(input: {
  readonly previous: OrchestrationV2LimitRecovery | null | undefined;
  readonly runId: string;
  readonly resetAt: string;
  readonly stoppedAtMs: number;
}): { readonly retryAttempt: number; readonly retryAt?: string } | null {
  const { previous } = input;
  const chained =
    previous?.retryAttempt !== undefined &&
    previous.runId !== input.runId &&
    input.stoppedAtMs - Date.parse(limitRecoveryResumeAt(previous)) <= RATE_LIMIT_RETRY_CHAIN_MS;
  const retryAttempt = chained ? previous!.retryAttempt! + 1 : 1;
  if (retryAttempt > MAX_RATE_LIMIT_RETRIES) return null;
  const retryAtMs = input.stoppedAtMs + rateLimitRetryBackoffMs(retryAttempt);
  return retryAtMs > Date.parse(input.resetAt)
    ? { retryAttempt, retryAt: DateTime.formatIso(DateTime.makeUnsafe(retryAtMs)) }
    : { retryAttempt };
}

/**
 * Whether a delegated child's failed run still waits on the server to recover
 * it (retry, hand off, or resume at the reset), so its parent must not take
 * the failure as the task's result yet. An undecided stop counts: the
 * recovery sweep decides it within seconds, and recording "no" releases it.
 */
export function limitRecoveryPending(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "archivedAt" | "deletedAt" | "settledOverride" | "limitRecovery"
  >;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly run: OrchestrationV2Run;
}): boolean {
  const { thread, run } = input;
  if (
    run.status !== "failed" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    latestExecutedRun(input.runs)?.id !== run.id
  )
    return false;
  const failure = latestRootProviderFailure(run, input.turnItems);
  if (failure?.class !== "usage_limit" || !failure.resetAt) return false;
  const resetMs = Date.parse(failure.resetAt);
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(run.completedAt ?? run.requestedAt)
  )
    return false;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== run.id || recovery.resetAt !== failure.resetAt) return true;
  return recovery.autoResume;
}

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
