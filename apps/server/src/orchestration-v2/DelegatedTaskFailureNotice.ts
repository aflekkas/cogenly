import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  limitRecoveryResumeAt,
  MessageId,
  type OrchestrationV2AppThread,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedTaskFailure,
  type OrchestrationV2DelegatedTaskRecovery,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "./ThreadManagementService.ts";

const MESSAGE_MAX_LENGTH = 300;
const MESSAGE_ID_PREFIX = "message:delegated-task-failure:";

function shortMessage(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > MESSAGE_MAX_LENGTH ? `${line.slice(0, MESSAGE_MAX_LENGTH - 1)}…` : line;
}

/**
 * Why a delegated child run ended without a result, or null when its parent
 * should not be told: it completed, or someone stopped it on purpose. A user
 * Stop and `task_cancel` (and a parent Stop reaching its tasks) all record an
 * interrupt request on the run; a run cancelled before it started was removed
 * from a queue or archived. `afterRestart` marks runs that restart recovery
 * settled, whose provider work the restart cut off.
 */
export function classifyDelegatedTaskFailure(input: {
  readonly run: OrchestrationV2Run;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly afterRestart: boolean;
}): Pick<OrchestrationV2DelegatedTaskFailure, "kind" | "message" | "resetAt"> | null {
  const { run, turnItems } = input;
  if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted") {
    return null;
  }
  if (turnItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request")) {
    return null;
  }
  if (run.status === "failed") {
    const failure = latestRootProviderFailure(run, turnItems);
    if (failure?.class === "usage_limit") {
      return {
        kind: failure.limitKind === "rate_limit" ? "rate_limit" : "usage_limit",
        message: shortMessage(failure.message),
        resetAt: failure.resetAt ?? null,
      };
    }
    const fallback = turnItems.findLast(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "error" }> =>
        item.type === "error" && item.runId === run.id,
    );
    return {
      kind: "provider_error",
      message: shortMessage(
        failure?.message ?? fallback?.failure.message ?? "The provider reported an error.",
      ),
    };
  }
  if (input.afterRestart) {
    return {
      kind: "interrupted_by_restart",
      message: "Cogenly restarted before the task finished.",
    };
  }
  if (run.status === "cancelled" && run.startedAt === null) return null;
  return {
    kind: "crashed",
    message: "The task's provider session ended before it finished.",
  };
}

const KIND_LABEL: Record<OrchestrationV2DelegatedTaskFailure["kind"], string> = {
  rate_limit: "rate limit",
  usage_limit: "usage limit",
  provider_error: "provider error",
  interrupted_by_restart: "interrupted by a restart",
  crashed: "crashed",
};

function suggestedAction(failure: OrchestrationV2DelegatedTaskFailure): string {
  switch (failure.kind) {
    case "rate_limit":
      return `Cogenly retried it and no other provider instance could take it. Continue it on another instance with thread_limit_handoff (threadId ${failure.childThreadId}) once one has headroom, or retry it later. Ask the user before switching accounts.`;
    case "usage_limit":
      return failure.resetAt
        ? `No other provider instance had headroom. Continue it with thread_limit_handoff (threadId ${failure.childThreadId}) when one does, or resume it after ${failure.resetAt}, when the limit resets. Ask the user before resuming.`
        : "Resume it once the usage limit resets. Ask the user before resuming.";
    case "interrupted_by_restart":
      return "Check its thread for partial work, then retry or continue it if the work is still needed.";
    case "provider_error":
    case "crashed":
      return "Retry it with a new delegate_task call if the work is still needed.";
  }
}

// A follow-up's id is new to the parent, so name the subagent and the task it continued.
function followUpNote(failure: OrchestrationV2DelegatedTaskFailure): string {
  return failure.followUpOf === undefined
    ? ""
    : ` It was a follow-up of task ${failure.followUpOf}: a later message to subagent "${failure.title}" (thread ${failure.childThreadId}) started it, and the earlier result of ${failure.followUpOf} is unchanged.`;
}

function failureLine(failure: OrchestrationV2DelegatedTaskFailure): string {
  const partial = failure.partialWork
    ? ` It may have left partial work in thread ${failure.childThreadId}.`
    : "";
  return `Delegated task ${failure.taskId} ("${failure.title}") stopped: ${KIND_LABEL[failure.kind]}.${followUpNote(failure)} ${failure.message}${partial} Suggested: ${suggestedAction(failure)}`;
}

/** The parent's turn input and timeline record for one or more failed child runs. */
export function delegatedTaskFailureNotice(
  failures: ReadonlyArray<OrchestrationV2DelegatedTaskFailure>,
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const first = failures[0]!;
  const summary =
    failures.length === 1
      ? `Agent "${first.title}" stopped: ${KIND_LABEL[first.kind]}`
      : `${failures.length} agents stopped: ${failures.map((failure) => `"${failure.title}"`).join(", ")}`;
  const text = [
    ...failures.map(failureLine),
    `Use task_status for details. This notice did not resume or retry anything.`,
  ].join("\n\n");
  return {
    text,
    notification: {
      source: {
        kind: "delegated_task",
        taskIds: Array.from(new Set(failures.map((failure) => failure.taskId))),
        ...(failures.length === 1 ? { childThreadId: first.childThreadId } : {}),
      },
      outcome: failures.every((failure) => failure.kind === "interrupted_by_restart")
        ? "cancelled"
        : "failed",
      summary,
      detail: text,
      delegatedFailures: failures,
    },
  };
}

const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/**
 * Why a delegated child's latest work stopped short, and what the server is
 * doing about it, as task_status reports it: a limit stop (and its retry,
 * handoff, or resume at reset) or a restart (and its continuation). Both are
 * null once the child finished or nothing interrupted it.
 */
export function delegatedTaskStop(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "limitRecovery">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  /** Error items of the child's recent runs. */
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** A restart cut the result run and its continuation is still pending. */
  readonly awaitingRestart: boolean;
}): {
  readonly stoppedOn: "rate_limit" | "usage_limit" | "restart" | null;
  readonly recovery: OrchestrationV2DelegatedTaskRecovery | null;
} {
  const latest = latestExecutedRun(input.runs);
  const none = { stoppedOn: null, recovery: null } as const;
  if (latest === null) return none;
  const limitKind = (run: OrchestrationV2Run) => {
    const failure = latestRootProviderFailure(run, input.turnItems);
    return failure?.class !== "usage_limit"
      ? null
      : failure.limitKind === "rate_limit"
        ? ("rate_limit" as const)
        : ("usage_limit" as const);
  };
  const recovery = input.thread.limitRecovery;
  if (latest.status === "failed") {
    const kind = limitKind(latest);
    if (kind === null) return none;
    const armed = recovery?.runId === latest.id && recovery.autoResume ? recovery : null;
    const at = armed === null ? null : limitRecoveryResumeAt(armed);
    return {
      stoppedOn: kind,
      recovery:
        armed === null || at === null
          ? null
          : armed.retryAttempt !== undefined
            ? { type: "retrying", at, attempt: armed.retryAttempt }
            : { type: "resuming_at_reset", at },
    };
  }
  if (TERMINAL_RUN_STATUSES.has(latest.status)) {
    return input.awaitingRestart
      ? { stoppedOn: "restart", recovery: { type: "resuming_after_restart" } }
      : none;
  }
  if (latest.restartContinuationOfRunId !== undefined) {
    return { stoppedOn: "restart", recovery: { type: "resuming_after_restart" } };
  }
  // A running continuation of a limit stop: a handoff, or a retry or resume.
  const handoff = latest.userMessageId.startsWith("limit-handoff:");
  if (!handoff && !latest.userMessageId.startsWith("limit-resume:")) return none;
  const source = input.runs
    .filter((run) => run.status === "failed" && run.id !== latest.id && runRanAfter(latest, run))
    .reduce<OrchestrationV2Run | undefined>(
      (newest, run) => (newest === undefined || runRanAfter(run, newest) ? run : newest),
      undefined,
    );
  const kind = source === undefined ? null : limitKind(source);
  if (kind === null) return none;
  if (handoff) {
    return {
      stoppedOn: kind,
      recovery: {
        type: "handed_off",
        providerInstanceId: latest.providerInstanceId,
        model: latest.modelSelection.model,
      },
    };
  }
  return {
    stoppedOn: kind,
    recovery:
      recovery?.runId === source?.id && recovery?.retryAttempt !== undefined
        ? {
            type: "retrying",
            at: limitRecoveryResumeAt(recovery),
            attempt: recovery.retryAttempt,
          }
        : recovery?.runId === source?.id && recovery !== null && recovery !== undefined
          ? { type: "resuming_at_reset", at: limitRecoveryResumeAt(recovery) }
          : null,
  };
}

function recoveryLine(
  failure: OrchestrationV2DelegatedTaskFailure,
  recovery: OrchestrationV2DelegatedTaskRecovery,
): string {
  const stop = `Delegated task ${failure.taskId} ("${failure.title}") hit a ${KIND_LABEL[failure.kind]}.${followUpNote(failure)} ${failure.message}`;
  switch (recovery.type) {
    case "handed_off":
      return `${stop} Cogenly handed it off to provider instance ${recovery.providerInstanceId} (${recovery.model}) with its context and re-ran the stopped request. It is still running; no action is needed.`;
    case "resuming_at_reset":
      return `${stop} No other provider instance had headroom, so Cogenly will resume it automatically at ${recovery.at}, when the limit resets. It is still pending; do not retry or re-delegate it.`;
    case "retrying":
      return `${stop} Cogenly retries it automatically at ${recovery.at} (attempt ${recovery.attempt}). No action is needed.`;
    case "resuming_after_restart":
      return `${stop} Cogenly resumes it after the restart. No action is needed.`;
  }
}

/** The parent's timeline record for a child stop the server is recovering on its own. */
export function delegatedTaskRecoveryNotice(
  failure: OrchestrationV2DelegatedTaskFailure & {
    readonly recovery: OrchestrationV2DelegatedTaskRecovery;
  },
): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const text = `${recoveryLine(failure, failure.recovery)} Use task_status for details.`;
  const summary =
    failure.recovery.type === "handed_off"
      ? `Agent "${failure.title}" hit a ${KIND_LABEL[failure.kind]}: handed off`
      : `Agent "${failure.title}" hit a ${KIND_LABEL[failure.kind]}: resumes automatically`;
  return {
    text,
    notification: {
      source: {
        kind: "delegated_task",
        taskIds: [failure.taskId],
        childThreadId: failure.childThreadId,
      },
      outcome: "updated",
      summary,
      detail: text,
      delegatedFailures: [failure],
    },
  };
}

/**
 * Tells a delegated child's parent that its child stopped on a limit and what
 * the server did about it (handed it off, or resumes it at the reset). It
 * queues behind the parent's turn like a failure notice, but reports a stop
 * that is not the task's result: the task stays running. Ids derive from the
 * child run and the recovery, so a repeated sweep sends it once.
 */
export const deliverDelegatedTaskRecoveryNotice = Effect.fn(
  "DelegatedTaskFailureNotice.deliverRecovery",
)(function* (input: {
  readonly childThreadId: ThreadId;
  readonly childRunId: RunId;
  readonly recovery: OrchestrationV2DelegatedTaskRecovery;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const child = yield* threads.getThreadRecords(input.childThreadId, ["runs", "turnItems"], {
    turnItemRunIds: [input.childRunId],
    turnItemTypes: ["error"],
  });
  const { lineage, forkedFrom } = child.thread;
  if (lineage.relationshipToParent !== "subagent" || lineage.parentThreadId === null) return;
  const run = child.runs.find((candidate) => candidate.id === input.childRunId);
  if (run === undefined) return;
  const failure = latestRootProviderFailure(run, child.turnItems);
  if (failure?.class !== "usage_limit") return;
  const parent = yield* threads.getThreadRecords(lineage.parentThreadId, ["subagents"]);
  if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
  const taskId = run.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : null);
  const task = parent.subagents.find(
    (candidate) =>
      candidate.id === taskId &&
      candidate.origin === "app_owned" &&
      candidate.childThreadId === input.childThreadId,
  );
  if (task === undefined) return;
  const notice = delegatedTaskRecoveryNotice({
    taskId: task.id,
    childThreadId: input.childThreadId,
    childRunId: run.id,
    title: reportLabel(task.title?.trim() || task.prompt) ?? "Delegated task",
    kind: failure.limitKind === "rate_limit" ? "rate_limit" : "usage_limit",
    message: shortMessage(failure.message),
    resetAt: failure.resetAt ?? null,
    partialWork: run.startedAt !== null,
    recovery: input.recovery,
    ...(task.followUpOf === undefined ? {} : { followUpOf: task.followUpOf }),
  });
  const key = `${task.id}:${run.id}:${input.recovery.type}`;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:delegated-task-recovery:${key}`),
    threadId: lineage.parentThreadId,
    messageId: MessageId.make(`message:delegated-task-recovery:${key}`),
    text: notice.text,
    notification: notice.notification,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  });
});

const failureKey = (failure: Pick<OrchestrationV2DelegatedTaskFailure, "taskId" | "childRunId">) =>
  `${failure.taskId}:${failure.childRunId}`;

function noticeFailures(
  message: OrchestrationV2ConversationMessage,
): ReadonlyArray<OrchestrationV2DelegatedTaskFailure> {
  return message.id.startsWith(MESSAGE_ID_PREFIX)
    ? (message.notification?.delegatedFailures ?? [])
    : [];
}

/**
 * Queues a notice on the parent that a delegated child run failed or was cut
 * off. It waits behind the parent's current turn and arrives as that turn's
 * next input. Ids derive from the task and child run, so a replayed effect or
 * restart never sends a second notice for one failure. A failure arriving while
 * an earlier notice is still queued replaces it with one combined notice, so
 * the children one restart cut off reach the parent together.
 */
export const deliverDelegatedTaskFailureNotice = Effect.fn("DelegatedTaskFailureNotice.deliver")(
  function* (input: {
    readonly parentThreadId: ThreadId;
    readonly taskId: NodeId;
    readonly childThreadId: ThreadId;
    readonly childRunId: RunId;
    readonly afterRestart: boolean;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const child = yield* threads.getThreadRecords(input.childThreadId, ["runs", "turnItems"], {
      turnItemRunIds: [input.childRunId],
      turnItemTypes: ["error", "run_interrupt_request"],
    });
    if (child.thread.archivedAt !== null || child.thread.deletedAt !== null) return;
    const run = child.runs.find((candidate) => candidate.id === input.childRunId);
    if (run === undefined) return;
    const classified = classifyDelegatedTaskFailure({
      run,
      turnItems: child.turnItems,
      afterRestart: input.afterRestart,
    });
    if (classified === null) return;

    const parent = yield* threads.getThreadRecords(
      input.parentThreadId,
      ["runs", "messages", "subagents"],
      { messageRoles: ["user"] },
    );
    if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
    const task: OrchestrationV2Subagent | undefined = parent.subagents.find(
      (candidate) =>
        candidate.id === input.taskId &&
        candidate.origin === "app_owned" &&
        candidate.childThreadId === input.childThreadId,
    );
    if (task === undefined) return;
    const failure: OrchestrationV2DelegatedTaskFailure = {
      taskId: task.id,
      childThreadId: input.childThreadId,
      childRunId: run.id,
      title: reportLabel(task.title?.trim() || task.prompt) ?? "Delegated task",
      ...classified,
      partialWork: run.startedAt !== null,
      ...(task.followUpOf === undefined ? {} : { followUpOf: task.followUpOf }),
    };
    const key = failureKey(failure);

    const queuedNotices = parent.runs
      .filter((candidate) => candidate.status === "queued")
      .flatMap((queued) => {
        const message = parent.messages.find((candidate) => candidate.id === queued.userMessageId);
        const failures = message === undefined ? [] : noticeFailures(message);
        return failures.length === 0 ? [] : [{ run: queued, failures }];
      });
    const alreadyNoticed = parent.messages.some((message) =>
      noticeFailures(message).some((existing) => failureKey(existing) === key),
    );
    if (!alreadyNoticed) {
      // The latest queued notice is folded into this one; it has not started, so nothing is lost.
      const merged = queuedNotices.at(-1);
      const notice = delegatedTaskFailureNotice([...(merged?.failures ?? []), failure]);
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:delegated-task-failure:${key}`),
        threadId: input.parentThreadId,
        messageId: MessageId.make(`${MESSAGE_ID_PREFIX}${key}`),
        text: notice.text,
        notification: notice.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    }
    // Drops queued notices a later combined notice already covers. Dispatch comes
    // first, so a crash in between leaves a duplicate rather than a lost failure.
    const refreshed = alreadyNoticed
      ? parent
      : yield* threads.getThreadRecords(input.parentThreadId, ["runs", "messages"], {
          messageRoles: ["user"],
        });
    const queued = refreshed.runs
      .filter((candidate) => candidate.status === "queued")
      .flatMap((queuedRun) => {
        const message = refreshed.messages.find(
          (candidate) => candidate.id === queuedRun.userMessageId,
        );
        const failures = message === undefined ? [] : noticeFailures(message);
        return failures.length === 0 ? [] : [{ run: queuedRun, keys: failures.map(failureKey) }];
      });
    for (const notice of queued) {
      const superseded = queued.some(
        (other) =>
          other.run.id !== notice.run.id &&
          other.keys.length > notice.keys.length &&
          notice.keys.every((noticeKey) => other.keys.includes(noticeKey)),
      );
      if (!superseded) continue;
      yield* threads.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`command:delegated-task-failure-merged:${notice.run.id}`),
        threadId: input.parentThreadId,
        runId: notice.run.id,
      });
    }
  },
);
