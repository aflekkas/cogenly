import type { ProviderUsageHeadroom, ServerProviderUsageLimits } from "@cogenly/contracts";

/** A usage reading older than this is reported, but flagged as possibly out of date. */
export const USAGE_STALE_AFTER_MS = 30 * 60_000;

/** What a reading says about headroom right now. A window whose reset passed counts as fresh. */
export function providerUsageHeadroom(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): ProviderUsageHeadroom {
  const checkedMs = limits === undefined ? Number.NaN : Date.parse(limits.checkedAt);
  const base = {
    checkedAt: limits?.checkedAt ?? null,
    stale: Number.isFinite(checkedMs) && nowMs - checkedMs > USAGE_STALE_AFTER_MS,
  };
  if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
    return { state: "unknown", remainingPercent: null, ...base, windows: [] };
  }
  const windows = limits.windows.map((window) => {
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    const resetPassed = Number.isFinite(resetMs) && resetMs <= nowMs;
    return {
      label: window.label,
      kind: window.kind,
      usedPercent: resetPassed ? 0 : Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      ...(resetPassed || window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    };
  });
  const remainingPercent = Math.min(...windows.map((window) => 100 - window.usedPercent));
  return {
    state: remainingPercent <= 0 ? "exhausted" : "available",
    remainingPercent,
    ...base,
    windows,
  };
}
