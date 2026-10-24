/**
 * Subagents that finished but whose parent has not been told yet. A background
 * subagent's result reaches its parent as a notification on the parent's next
 * turn, so while the parent is busy the timeline would otherwise show nothing.
 * These rows stand in for that notification until it lands, then give way to
 * it.
 */
import type { OrchestrationV2NotificationSource } from "@t3tools/contracts";

export type PendingCompletionOutcome = "completed" | "failed" | "cancelled";

export interface PendingCompletionSubagentInput {
  readonly id: string;
  readonly threadId: string;
  readonly origin: "provider_native" | "app_owned";
  readonly childThreadId: string | null;
  readonly status: string;
  readonly startedAtMs: number;
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

/** Batched delegated notices identify tasks even when they have no single child thread. */
export function notifiedSubagentCompletionTimes(
  notifications: ReadonlyArray<{
    readonly source: OrchestrationV2NotificationSource;
    readonly atMs: number;
  }>,
) {
  const byChild = new Map<string, number>();
  const byTask = new Map<string, number>();
  const note = (map: Map<string, number>, id: string | undefined, at: number) => {
    if (id !== undefined && at > (map.get(id) ?? Number.NEGATIVE_INFINITY)) map.set(id, at);
  };
  for (const { source, atMs } of notifications) {
    if (
      source.kind === "subagent" ||
      source.kind === "delegated_task" ||
      source.kind === "work_task"
    ) {
      note(byChild, source.childThreadId, atMs);
    }
    if (source.kind === "delegated_task") {
      for (const taskId of source.taskIds) note(byTask, taskId, atMs);
    }
  }
  return { byChild, byTask };
}

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
  readonly notifiedAtMsByTask: ReadonlyMap<string, number>;
  readonly backgroundChildren: ReadonlySet<string>;
  readonly latestParentRunAtMs: number | null;
}): PendingCompletion[] {
  const byChild = new Map<string, PendingCompletion>();
  const latestByChild = new Map<string, PendingCompletionSubagentInput>();
  for (const subagent of input.subagents) {
    if (subagent.threadId !== input.threadId || subagent.childThreadId === null) continue;
    const previous = latestByChild.get(subagent.childThreadId);
    if (
      previous === undefined ||
      subagent.startedAtMs > previous.startedAtMs ||
      (subagent.startedAtMs === previous.startedAtMs &&
        (subagent.completedAtMs ?? Number.POSITIVE_INFINITY) >=
          (previous.completedAtMs ?? Number.POSITIVE_INFINITY))
    ) {
      latestByChild.set(subagent.childThreadId, subagent);
    }
  }
  // A newer invocation owns the child even while it is running: an old failure
  // waiting for delivery must not reappear beneath its resumed conversation.
  for (const subagent of latestByChild.values()) {
    if (subagent.childThreadId === null) continue;
    const outcome = TERMINAL[subagent.status];
    if (outcome === undefined || subagent.completedAtMs === null) continue;
    // A footer is only a bridge until the parent takes its next turn. Keep
    // undelivered results durable, but let their ordinary timeline rows own
    // the history once a later turn (including a failed resume) supersedes it.
    if (input.latestParentRunAtMs !== null && input.latestParentRunAtMs > subagent.completedAtMs)
      continue;
    const reportsBack =
      subagent.origin === "app_owned"
        ? subagent.completionDelivery !== undefined &&
          UNDELIVERED.has(subagent.completionDelivery.state)
        : input.backgroundChildren.has(subagent.childThreadId);
    if (!reportsBack) continue;
    const notifiedAt = input.notifiedAtMsByChild.get(subagent.childThreadId);
    if (notifiedAt !== undefined && notifiedAt >= subagent.completedAtMs) continue;
    const taskNotifiedAt = input.notifiedAtMsByTask.get(subagent.id);
    if (taskNotifiedAt !== undefined && taskNotifiedAt >= subagent.completedAtMs) continue;
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
