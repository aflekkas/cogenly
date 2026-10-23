import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare, remainingPercent } from "@t3tools/shared/usageLimits";

import type { UsageMeterMode } from "../../appearancePreferences";

/**
 * Quota left and quota used always sum to 100, so a bar and its label never
 * disagree about rounding when the mode flips.
 */
export function meterPercent(remaining: number, mode: UsageMeterMode): number {
  return mode === "remaining" ? remaining : 100 - remaining;
}

/** `58% left` or `42% used`. */
export function quotaLabel(remaining: number, mode: UsageMeterMode): string {
  return mode === "remaining" ? `${remaining}% left` : `${100 - remaining}% used`;
}

/** `40% of the window left` or `60% of the window elapsed`. */
export function windowShareLabel(timeLeft: number, mode: UsageMeterMode): string {
  return mode === "remaining"
    ? `${timeLeft}% of the window left`
    : `${100 - timeLeft}% of the window elapsed`;
}

export interface WindowMeter {
  /** How much of the bar is filled, 0..100. */
  readonly fill: number;
  /** Where even spending would put the fill; null when the window's length or reset is unknown. */
  readonly marker: number | null;
  /** `58% left` / `42% used`. */
  readonly quota: string;
  /** `40% of the window left` / `60% of the window elapsed`; null with the marker. */
  readonly clock: string | null;
}

/**
 * One window as a meter. Both modes show the same facts on the same scale: the
 * fill is quota left or used, and the marker is the clock read the same way
 * (time left or time elapsed). The pace verdict is `paceOf`'s and does not
 * depend on the mode; only the side of the marker the fill ends on flips.
 */
export function windowMeter(
  window: ServerProviderUsageWindow,
  now: number,
  mode: UsageMeterMode,
): WindowMeter {
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  return {
    fill: meterPercent(remaining, mode),
    marker: timeLeft === null ? null : meterPercent(timeLeft, mode),
    quota: quotaLabel(remaining, mode),
    clock: timeLeft === null ? null : windowShareLabel(timeLeft, mode),
  };
}

/** `62% left`, `38% used`, `Usage unknown` for a handoff candidate's tightest window. */
export function headroomLabel(remaining: number | null, mode: UsageMeterMode): string {
  return remaining === null ? "Usage unknown" : quotaLabel(remaining, mode);
}
