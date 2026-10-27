/**
 * Which health items the server fixes on its own, without I/O. Only fixes
 * that are safe to repeat and lose nothing run automatically: updating a
 * paired machine to the version already running here, retrying sync, and
 * stopping runs that lost their provider session. Running a task, discarding
 * quarantined changes and signing in always wait for the owner or an agent.
 */
import type { EnvironmentId, MachineHealthFix, MachineHealthItem } from "@cogenly/contracts";
import * as Duration from "effect/Duration";

import type { HealthAutoFixView } from "./HealthAlertsState.ts";

const AUTO_FIXES: ReadonlySet<MachineHealthFix> = new Set([
  "update-machine",
  "retry-sync",
  "stop-runs",
  "resume",
]);

/** A fix that ran but whose item is still there is tried again after this. */
const AUTO_FIX_RECHECK_AFTER = Duration.minutes(10);
/** Attempts before a lingering item counts as failed. */
const AUTO_FIX_MAX_ATTEMPTS = 3;
/** A failed item is tried again, quietly, after this. */
const AUTO_FIX_RETRY_FAILED_AFTER = Duration.minutes(30);

interface AutoFixAttempt {
  readonly attempts: number;
  readonly lastAttemptAtMs: number;
  /** Set once a fix failed or the item outlived every attempt. */
  readonly failure: string | null;
}

export type HealthAutoFixState = ReadonlyMap<string, AutoFixAttempt>;

export const initialHealthAutoFixState: HealthAutoFixState = new Map();

/**
 * Whether the server fixes this item itself. A machine that is behind is
 * updated by the newer machine it is paired with, never by itself too: two
 * requests would collide on the update already in progress.
 */
export function isAutoFixable(item: MachineHealthItem, self: EnvironmentId): boolean {
  if (item.status === "ok" || item.status === "unknown") return false;
  if (item.fix === null || !AUTO_FIXES.has(item.fix)) return false;
  return !(
    item.fix === "update-machine" &&
    item.target?._tag === "machine" &&
    item.target.environmentId === self
  );
}

/** The items to fix now, and the state with every lingering item stepped once. */
export function planHealthAutoFix(
  state: HealthAutoFixState,
  items: ReadonlyArray<MachineHealthItem>,
  self: EnvironmentId,
  nowMs: number,
): { readonly due: ReadonlyArray<MachineHealthItem>; readonly state: HealthAutoFixState } {
  const next = new Map<string, AutoFixAttempt>();
  const due: Array<MachineHealthItem> = [];
  for (const item of items) {
    if (!isAutoFixable(item, self)) continue;
    const previous = state.get(item.key);
    if (previous === undefined) {
      due.push(item);
      next.set(item.key, { attempts: 0, lastAttemptAtMs: nowMs, failure: null });
      continue;
    }
    const sinceLast = nowMs - previous.lastAttemptAtMs;
    if (previous.failure !== null) {
      if (sinceLast >= Duration.toMillis(AUTO_FIX_RETRY_FAILED_AFTER)) {
        due.push(item);
        next.set(item.key, { ...previous, lastAttemptAtMs: nowMs });
      } else {
        next.set(item.key, previous);
      }
      continue;
    }
    if (sinceLast < Duration.toMillis(AUTO_FIX_RECHECK_AFTER)) {
      next.set(item.key, previous);
    } else if (previous.attempts >= AUTO_FIX_MAX_ATTEMPTS) {
      next.set(item.key, {
        ...previous,
        failure: `Fixed automatically ${previous.attempts} times, but it keeps coming back.`,
      });
    } else {
      due.push(item);
      next.set(item.key, { ...previous, lastAttemptAtMs: nowMs });
    }
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
  if (outcome.status === "resolved") {
    next.delete(itemKey);
    return next;
  }
  next.set(itemKey, {
    ...previous,
    attempts: previous.attempts + 1,
    failure: outcome.status === "fixed" ? null : outcome.message,
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
