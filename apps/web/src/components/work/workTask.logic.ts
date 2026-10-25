import type { MessageId, RunId, WorkHandoffLink, WorkTask } from "@cogenly/contracts";

import { anchorAtTurnEnd } from "./work.logic";

/**
 * What a chat's task card shows. Proposed and dismissed are the card's own
 * state; once started, the Work thread's live state decides, and the reported
 * outcome stands in when the thread is not loaded or is gone.
 */
export type WorkTaskCardState =
  | "proposed"
  | "dismissed"
  | "starting"
  | "running"
  | "attention"
  | "done"
  | "failed"
  | "stopped";

export const WORK_TASK_STATE_LABEL: Record<WorkTaskCardState, string> = {
  proposed: "Proposed",
  dismissed: "Dismissed",
  starting: "Started",
  running: "Running",
  attention: "Needs input",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const LIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The card state of `task`, given its Work thread's shell when the client has it. */
export function deriveWorkTaskCardState(
  task: Pick<WorkTask, "status" | "outcome">,
  thread: {
    readonly latestRun: { readonly status: string } | null;
    readonly runtime: { readonly status: string } | null;
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
  } | null,
): WorkTaskCardState {
  if (task.status === "proposed") return "proposed";
  if (task.status === "dismissed") return "dismissed";
  if (thread !== null) {
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
    if (thread.runtime !== null && LIVE_RUNTIME.has(thread.runtime.status)) return "running";
    switch (thread.latestRun?.status) {
      case undefined:
        break;
      case "completed":
        return "done";
      case "failed":
        return "failed";
      case "interrupted":
      case "cancelled":
      case "rolled_back":
        return "stopped";
      default:
        return "running";
    }
  }
  switch (task.outcome?.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case undefined:
      return "starting";
  }
}

/** Whether the card's Stop applies: the task's Work is doing something. */
export function workTaskCanStop(state: WorkTaskCardState): boolean {
  return state === "running" || state === "attention" || state === "starting";
}

export interface WorkTaskAnchors {
  readonly byMessageId: ReadonlyMap<MessageId, ReadonlyArray<WorkTask>>;
  readonly unanchored: ReadonlyArray<WorkTask>;
}

type AnchorMessage = Parameters<typeof anchorAtTurnEnd>[1][number];

/**
 * Where each task card sits in its chat: after the last reply of the turn
 * that created it, so the agent's "I've started a task" reads above the card.
 * A card from an unknown or unloaded turn sits after the turn that had ended
 * when it was created, as a Work handoff marker does.
 */
export function anchorWorkTasks(
  tasks: ReadonlyArray<WorkTask>,
  messages: ReadonlyArray<AnchorMessage>,
): WorkTaskAnchors {
  const byRun = new Map<RunId, MessageId>();
  for (const message of messages) {
    if (message.runId === null || message.role === "system") continue;
    // The run's last reply wins; its user message only until a reply exists.
    if (message.role === "assistant" || !byRun.has(message.runId)) {
      byRun.set(message.runId, message.id);
    }
  }
  const byMessageId = new Map<MessageId, WorkTask[]>();
  const unanchored: WorkTask[] = [];
  for (const task of tasks.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const anchor =
      (task.runId === undefined ? undefined : byRun.get(task.runId)) ??
      anchorAtTurnEnd(task.createdAt, messages);
    if (anchor === null) {
      unanchored.push(task);
      continue;
    }
    byMessageId.set(anchor, [...(byMessageId.get(anchor) ?? []), task]);
  }
  return { byMessageId, unanchored };
}

/** Work handoff links not already shown as a task card. */
export function handoffsWithoutTasks(
  links: ReadonlyArray<WorkHandoffLink>,
  tasks: ReadonlyArray<WorkTask>,
): ReadonlyArray<WorkHandoffLink> {
  const taskThreads = new Set(tasks.flatMap((task) => task.threadId ?? []));
  return taskThreads.size === 0 ? links : links.filter((link) => !taskThreads.has(link.threadId));
}
