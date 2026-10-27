/**
 * Which health items the server fixes on its own, without I/O. Only fixes
 * that are safe to repeat and lose nothing run automatically: retrying sync
 * and stopping runs that lost their provider session. Updating a machine,
 * running a task, discarding quarantined changes and signing in always wait
 * for the owner or an agent.
 */
import type { MachineHealthFix, MachineHealthItem } from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";

import type { HealthAutoFixView } from "./HealthAlertsState.ts";

const AUTO_FIXES: ReadonlySet<MachineHealthFix> = new Set(["retry-sync", "stop-runs", "resume"]);

const AUTO_FIX_RECHECK_AFTER = Duration.minutes(10);
const AUTO_FIX_MAX_ATTEMPTS = 3;

export const AutoFixAttempt = Schema.Struct({
  revision: Schema.String,
  attempts: Schema.Int,
  lastAttemptAtMs: Schema.Number,
  failure: Schema.NullOr(Schema.String),
});
type AutoFixAttempt = typeof AutoFixAttempt.Type;

export type HealthAutoFixState = ReadonlyMap<string, AutoFixAttempt>;

export const initialHealthAutoFixState: HealthAutoFixState = new Map();

/** Whether the server fixes this item itself. */
export function isAutoFixable(item: MachineHealthItem): boolean {
  if (item.status === "ok" || item.status === "unknown") return false;
  return item.fix !== null && AUTO_FIXES.has(item.fix);
}

/** The items to fix now, and the state with every lingering item stepped once. */
export function planHealthAutoFix(
  state: HealthAutoFixState,
  items: ReadonlyArray<MachineHealthItem>,
  nowMs: number,
): { readonly due: ReadonlyArray<MachineHealthItem>; readonly state: HealthAutoFixState } {
  // Keep exhausted items even while absent: a disappearing item is not a new budget.
  const next = new Map(state);
  const due: Array<MachineHealthItem> = [];
  for (const item of items) {
    if (!isAutoFixable(item)) continue;
    // Keep the former update-version slot so persisted sync/run budgets stay valid.
    const revision = JSON.stringify([item.key, item.fix, item.target, null]);
    const stored = state.get(item.key);
    let previous = stored?.revision === revision ? stored : undefined;
    const delay =
      Duration.toMillis(AUTO_FIX_RECHECK_AFTER) * 2 ** Math.max(0, (previous?.attempts ?? 0) - 1);
    if (previous !== undefined && nowMs - previous.lastAttemptAtMs < delay) continue;
    if (previous !== undefined && previous.attempts > 0 && previous.failure === null) {
      previous = {
        ...previous,
        failure: "The automatic fix ran, but this problem is still present.",
      };
    }
    if (previous !== undefined && previous.attempts >= AUTO_FIX_MAX_ATTEMPTS) {
      next.set(item.key, {
        ...previous,
        failure:
          previous.failure ??
          `Fixed automatically ${previous.attempts} times, but it keeps coming back.`,
      });
      continue;
    }
    due.push(item);
    next.set(item.key, {
      revision,
      attempts: (previous?.attempts ?? 0) + 1,
      lastAttemptAtMs: nowMs,
      failure: previous?.failure ?? null,
    });
  }
  return { due, state: next };
}

/** Records one fix's outcome: a failure alerts, anything else waits for the item to clear. */
export function recordHealthAutoFix(
  state: HealthAutoFixState,
  itemKey: string,
  outcome: {
    readonly status: "fixed" | "failed" | "resolved" | "manual";
    readonly message: string;
  },
): HealthAutoFixState {
  const previous = state.get(itemKey);
  if (previous === undefined) return state;
  const next = new Map(state);
  next.set(itemKey, {
    ...previous,
    failure: ["fixed", "resolved"].includes(outcome.status) ? null : outcome.message,
  });
  return next;
}

/** What HealthAlerts holds back, and what it alerts with. */
export function healthAutoFixView(state: HealthAutoFixState): HealthAutoFixView {
  const holds = new Set<string>();
  const failures = new Map<string, string>();
  for (const [key, attempt] of state) {
    if (attempt.failure === null) holds.add(key);
    else failures.set(key, attempt.failure);
  }
  return { holds, failures };
}
