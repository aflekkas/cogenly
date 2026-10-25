import {
  limitRecoveryResumeAt,
  MAX_RATE_LIMIT_RETRIES,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@cogenly/contracts";
import type { TimestampFormat } from "@cogenly/contracts/settings";
import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/models";

import { formatUpcomingTimestamp } from "../../timestampFormat";

/** One usage-limit stop: the run it ended and what the provider said about its reset. */
export interface UsageLimitStop {
  readonly runId: RunId;
  readonly resetAt: string | null;
  readonly stoppedAt: string;
  readonly recovery: OrchestrationV2LimitRecovery | null;
  readonly snoozedUntil: string | null;
}

/**
 * What happens next for a usage-limit stop. Every state names one outcome, and
 * its actions move to the opposite state instead of flipping a label in place.
 */
export type UsageLimitRecoveryState =
  /** The provider gave no reset time this stop can wait for. */
  | { readonly kind: "no-reset" }
  /**
   * Continues on its own at `resumesAt`: the reset, a retry backoff, or a
   * snooze that outlasts them. `retryAttempt` marks a short-term rate limit
   * the server is retrying.
   */
  | {
      readonly kind: "scheduled";
      readonly resetAt: string;
      readonly resumesAt: string;
      readonly retryAttempt?: number;
    }
  /** The user opted this stop out; the reset is still ahead. */
  | { readonly kind: "cancelled"; readonly resetAt: string }
  /** Scheduled and due: the server is starting the continuation. */
  | { readonly kind: "resuming"; readonly resetAt: string }
  /** The reset passed with nothing scheduled, so it waits for the user. */
  | { readonly kind: "reset-passed"; readonly resetAt: string };

/**
 * Resolve the stop against the user's recorded choice. A stop with no choice
 * yet follows the environment's auto-resume default, which the server applies
 * only while the reset is ahead.
 */
export function resolveUsageLimitRecovery(
  stop: UsageLimitStop,
  autoResumeByDefault: boolean,
  nowMs: number,
): UsageLimitRecoveryState {
  const { resetAt } = stop;
  const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (resetAt === null || !Number.isFinite(resetMs) || resetMs <= Date.parse(stop.stoppedAt)) {
    return { kind: "no-reset" };
  }
  const recorded =
    stop.recovery?.runId === stop.runId && stop.recovery.resetAt === resetAt ? stop.recovery : null;
  if (resetMs <= nowMs && recorded === null) return { kind: "reset-passed", resetAt };
  const autoResume = recorded?.autoResume ?? autoResumeByDefault;
  if (!autoResume)
    return resetMs <= nowMs ? { kind: "reset-passed", resetAt } : { kind: "cancelled", resetAt };
  const { snoozedUntil } = stop;
  const dueAt = recorded === null ? resetAt : limitRecoveryResumeAt(recorded);
  const resumesAt =
    snoozedUntil !== null && Date.parse(snoozedUntil) > Date.parse(dueAt) ? snoozedUntil : dueAt;
  return Date.parse(resumesAt) <= nowMs
    ? { kind: "resuming", resetAt }
    : {
        kind: "scheduled",
        resetAt,
        resumesAt,
        ...(recorded?.retryAttempt === undefined ? {} : { retryAttempt: recorded.retryAttempt }),
      };
}

/** The stop a thread shell is in, or null when it is not stopped on a usage limit. */
export function usageLimitStopForThread(thread: EnvironmentThreadShell): UsageLimitStop | null {
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    thread.latestRun === null
  )
    return null;
  return {
    runId: thread.latestRun.runId,
    resetAt: thread.runtime.usageLimitResetAt ?? null,
    stoppedAt: thread.latestRun.completedAt ?? thread.updatedAt,
    recovery: thread.limitRecovery ?? null,
    snoozedUntil: thread.snoozedUntil,
  };
}

/** The update that moves a stop with a reset to resuming (or not) at that reset. */
export function usageLimitAutoResumeUpdate(
  stop: UsageLimitStop,
  autoResume: boolean,
): OrchestrationV2LimitRecoveryUpdate | null {
  return stop.resetAt === null ? null : { runId: stop.runId, resetAt: stop.resetAt, autoResume };
}

/** "in 3h 20m", "in 12m", "in under a minute", "in 2d 4h". */
export function formatResetCountdown(targetMs: number, nowMs: number): string {
  const minutes = Math.floor((targetMs - nowMs) / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours}h` : `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `in ${days}d` : `in ${days}d ${hours % 24}h`;
}

/** "at 3:20 PM" today, "tomorrow at 3:20 PM", "on 8/13 3:20 PM" later. */
function upcomingPhrase(isoDate: string, timestampFormat: TimestampFormat, nowMs: number): string {
  const label = formatUpcomingTimestamp(isoDate, timestampFormat, nowMs);
  if (label.startsWith("tomorrow")) return label;
  const sameDay = new Date(isoDate).toDateString() === new Date(nowMs).toDateString();
  return sameDay ? `at ${label}` : `on ${label}`;
}

/** The banner's state line and its supporting detail. */
export function usageLimitRecoveryCopy(
  state: UsageLimitRecoveryState,
  timestampFormat: TimestampFormat,
  nowMs: number,
): { readonly title: string; readonly description: string } {
  switch (state.kind) {
    case "scheduled": {
      const countdown = formatResetCountdown(Date.parse(state.resumesAt), nowMs);
      if (state.retryAttempt !== undefined) {
        return {
          title: `Retrying automatically ${countdown}`,
          description: `Rate limited by the provider. Retry ${state.retryAttempt} of ${MAX_RATE_LIMIT_RETRIES}.`,
        };
      }
      return {
        title: `Resumes automatically ${upcomingPhrase(state.resumesAt, timestampFormat, nowMs)}`,
        description:
          state.resumesAt === state.resetAt
            ? `Usage limit reached. Resets ${countdown}.`
            : `Usage limit reached. Snoozed past the reset, so it resumes ${countdown}.`,
      };
    }
    case "cancelled":
      return {
        title: "Won't resume automatically",
        description: `Usage limit resets ${upcomingPhrase(state.resetAt, timestampFormat, nowMs)}, ${formatResetCountdown(Date.parse(state.resetAt), nowMs)}.`,
      };
    case "resuming":
      return { title: "Resuming", description: "The usage limit reset." };
    case "reset-passed":
      return { title: "Usage limit reset", description: "Resume when you're ready." };
    case "no-reset":
      return {
        title: "Usage limit reached",
        description: "The provider gave no reset time. Resume to retry.",
      };
  }
}

/**
 * Which "at reset" action a thread menu offers: only while the reset is ahead,
 * so the choice still changes what happens.
 */
export function usageLimitMenuState(
  thread: EnvironmentThreadShell,
  autoResumeByDefault: boolean,
  nowMs: number,
): "scheduled" | "cancelled" | null {
  const stop = usageLimitStopForThread(thread);
  if (stop === null) return null;
  const { kind } = resolveUsageLimitRecovery(stop, autoResumeByDefault, nowMs);
  return kind === "scheduled" || kind === "cancelled" ? kind : null;
}
