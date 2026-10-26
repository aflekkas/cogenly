import type { OrchestrationV2Run, OrchestrationV2TurnItem, RunId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Provider rate-limit backoff, derived from the running retry item the
 * adapters record while the provider waits out a 429. The Codex CLI waits
 * silently between `turn/started` and the first item (its log shows
 * `responses_retry` with a multi-minute delay); the `error` notification it
 * does send becomes this item, so it is the reliable in-protocol signal for
 * both providers (Claude's `api_retry` system message lands in the same
 * shape). Pure: callers pass the projection slice and the clock reading.
 */

/** Shown and enforced when a retry item names no delay (Codex names none). */
export const PROVIDER_BACKOFF_FALLBACK_MS = 60_000;

export interface ProviderBackoff {
  readonly runId: RunId;
  /** When the provider is expected to try again, epoch milliseconds. */
  readonly retryAtMs: number;
  readonly attempt: number;
  readonly maxAttempts: number | null;
}

type RetryItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

/** A still-running retry caused by a short-term 429 throttle, not a spent quota. */
export function isRateLimitRetryItem(item: OrchestrationV2TurnItem): item is RetryItem {
  if (item.type !== "error" || item.status !== "running" || item.retry === undefined) {
    return false;
  }
  if (item.failure.class !== "usage_limit") return false;
  if (item.failure.limitKind === "rate_limit") return true;
  // Items recorded before the limitKind split: the Codex rate-limit code is
  // the only other marker of a throttle rather than an exhausted window.
  return item.failure.code === "rateLimitExceeded";
}

function retryAtMs(item: RetryItem): number {
  const startedMs = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
  const delayMs = item.retry?.retryDelayMs ?? null;
  if (delayMs !== null && delayMs > 0) {
    return startedMs + delayMs;
  }
  if (item.failure.resetAt !== null && item.failure.resetAt !== undefined) {
    const resetMs = Date.parse(item.failure.resetAt);
    if (Number.isFinite(resetMs)) return resetMs;
  }
  return startedMs + PROVIDER_BACKOFF_FALLBACK_MS;
}

/**
 * The backoff the given run is currently in, or null. A retry whose time has
 * passed is no longer a backoff: the provider is trying again, so steering
 * and the status line go back to normal.
 */
export function providerBackoffForRun(input: {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runId: RunId;
  /** Omit when no clock reading is available: a running retry then counts as backing off. */
  readonly nowMs?: number;
}): ProviderBackoff | null {
  const item = (input.turnItems ?? []).findLast(
    (candidate): candidate is RetryItem =>
      candidate.runId === input.runId && isRateLimitRetryItem(candidate),
  );
  if (item === undefined || item.retry === undefined) return null;
  const retryAt = retryAtMs(item);
  if (input.nowMs !== undefined && input.nowMs >= retryAt) return null;
  return {
    runId: input.runId,
    retryAtMs: retryAt,
    attempt: item.retry.attempt,
    maxAttempts: item.retry.maxAttempts,
  };
}

/** The backoff of the latest still-active run in a projection, if any. */
export function activeProviderBackoff(input: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly nowMs?: number;
}): ProviderBackoff | null {
  const active = (input.runs ?? []).findLast(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
  if (active === undefined) return null;
  return providerBackoffForRun({
    turnItems: input.turnItems,
    runId: active.id,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
}
