import type { EnvironmentThreadState } from "@cogenly/client-runtime/state/threads";
import * as Option from "effect/Option";

import type { ThreadRouteTarget } from "./threadRoutes";
import { threadRouteTargetKey } from "./threadRouteSlots";

/**
 * The longest the current thread stays on screen after navigating to one
 * whose content has not loaded. Past it the next thread shows in its loading
 * layout rather than leaving the click unanswered.
 */
export const THREAD_ROUTE_HOLD_MAX_MS = 180;

/**
 * Whether a thread can open complete: its detail is loaded or settled
 * (deleted, failed), the timeline has painted it before this session, or
 * there is nothing to load. An unknown shell holds nothing, so a missing
 * thread says it is gone at once.
 */
export function isThreadRouteContentReady(input: {
  readonly state: Pick<EnvironmentThreadState, "data" | "status" | "error">;
  readonly shell: {
    readonly itemCount: number;
    readonly latestUserMessageAt: unknown;
    readonly latestRun?: unknown;
  } | null;
  readonly hasRememberedTimeline: boolean;
}): boolean {
  const { state, shell } = input;
  if (shell === null || input.hasRememberedTimeline) return true;
  if (Option.isSome(state.data) || state.status === "deleted" || Option.isSome(state.error)) {
    return true;
  }
  return shell.itemCount === 0 && shell.latestUserMessageAt === null && shell.latestRun == null;
}

/**
 * Which target the thread view renders. Moving from one server thread to
 * another keeps the shown one (inert) while the next loads, until it is
 * ready or the hold runs out. Drafts never hold: a draft's promotion to its
 * thread must swap in place, and a new draft has nothing to wait for.
 */
export function resolveThreadRouteHold(input: {
  readonly shown: ThreadRouteTarget | null;
  readonly next: ThreadRouteTarget;
  readonly nextReady: boolean;
  readonly expired: boolean;
  /** The view only stands in for another route, so it never holds. */
  readonly retained: boolean;
}): { readonly target: ThreadRouteTarget; readonly holding: boolean } {
  const { shown, next } = input;
  if (
    shown === null ||
    input.retained ||
    input.nextReady ||
    input.expired ||
    shown.kind !== "server" ||
    next.kind !== "server" ||
    threadRouteTargetKey(shown) === threadRouteTargetKey(next)
  ) {
    return { target: next, holding: false };
  }
  return { target: shown, holding: true };
}

/** What is left of the hold that began at `since`. */
export function threadRouteHoldRemainingMs(since: number, now: number): number {
  return Math.max(0, THREAD_ROUTE_HOLD_MAX_MS - (now - since));
}
