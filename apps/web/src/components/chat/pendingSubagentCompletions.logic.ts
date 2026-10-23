/**
 * Subagents that finished but whose parent has not been told yet. A background
 * subagent's result reaches its parent as a notification on the parent's next
 * turn, so while the parent is busy the timeline would otherwise show nothing.
 * These rows stand in for that notification until it lands, then give way to
 * it.
 */

export type PendingCompletionOutcome = "completed" | "failed" | "cancelled";

export interface PendingCompletionSubagentInput {
  readonly id: string;
  readonly threadId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly childThreadId: string | null;
  readonly status: string;
  readonly completedAtMs: number | null;
  /** App-owned delegations record their delivery; provider-native ones do not. */
  readonly completionDelivery?: { readonly state: string } | undefined;
}

export interface PendingCompletion {
  readonly subagentId: string;
  readonly childThreadId: string;
  readonly outcome: PendingCompletionOutcome;
  readonly completedAtMs: number;
}

const TERMINAL: Record<string, PendingCompletionOutcome> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "cancelled",
};

/** Delivery states that mean the parent has not taken the result in yet. */
const UNDELIVERED = new Set(["pending", "claimed"]);

/**
 * `notifiedAtMsByChild` holds, per child thread, the newest notification the
 * parent's timeline already shows for it. `backgroundChildren` are provider-
 * native children seen running in the background: only those report back by
 * notification (a foreground subagent returns through its own tool call).
 */
export function pendingSubagentCompletions(input: {
  readonly threadId: string;
  readonly subagents: ReadonlyArray<PendingCompletionSubagentInput>;
  readonly notifiedAtMsByChild: ReadonlyMap<string, number>;
  readonly backgroundChildren: ReadonlySet<string>;
}): PendingCompletion[] {
  const byChild = new Map<string, PendingCompletion>();
  for (const subagent of input.subagents) {
    if (subagent.threadId !== input.threadId || subagent.childThreadId === null) continue;
    const outcome = TERMINAL[subagent.status];
    if (outcome === undefined || subagent.completedAtMs === null) continue;
    const reportsBack =
      subagent.origin === "app_owned"
        ? subagent.completionDelivery !== undefined &&
          UNDELIVERED.has(subagent.completionDelivery.state)
        : input.backgroundChildren.has(subagent.childThreadId);
    if (!reportsBack) continue;
    const notifiedAt = input.notifiedAtMsByChild.get(subagent.childThreadId);
    if (notifiedAt !== undefined && notifiedAt >= subagent.completedAtMs) continue;
    const existing = byChild.get(subagent.childThreadId);
    if (existing !== undefined && existing.completedAtMs >= subagent.completedAtMs) continue;
    byChild.set(subagent.childThreadId, {
      subagentId: subagent.id,
      childThreadId: subagent.childThreadId,
      outcome,
      completedAtMs: subagent.completedAtMs,
    });
  }
  return [...byChild.values()].sort((left, right) => left.completedAtMs - right.completedAtMs);
}
