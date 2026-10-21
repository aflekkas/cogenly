import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedTaskFailure,
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
        kind: "rate_limit",
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
  provider_error: "provider error",
  interrupted_by_restart: "interrupted by a restart",
  crashed: "crashed",
};

function suggestedAction(failure: OrchestrationV2DelegatedTaskFailure): string {
  switch (failure.kind) {
    case "rate_limit":
      return failure.resetAt
        ? `Resume it after ${failure.resetAt}, when the limit resets. Do not retry before then, and ask the user before resuming.`
        : "Resume it once the usage limit resets. Ask the user before resuming.";
    case "interrupted_by_restart":
      return "Check its thread for partial work, then retry or continue it if the work is still needed.";
    case "provider_error":
    case "crashed":
      return "Retry it with a new delegate_task call if the work is still needed.";
  }
}

function failureLine(failure: OrchestrationV2DelegatedTaskFailure): string {
  const partial = failure.partialWork
    ? ` It may have left partial work in thread ${failure.childThreadId}.`
    : "";
  return `Delegated task ${failure.taskId} ("${failure.title}") stopped: ${KIND_LABEL[failure.kind]}. ${failure.message}${partial} Suggested: ${suggestedAction(failure)}`;
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
