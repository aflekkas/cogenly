import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  UsageLimitHandoffError,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@cogenly/shared/model";
import { formatSnoozeTime, resolveSnoozeUntil } from "@cogenly/shared/snooze";
import { formatThreadLink } from "@cogenly/shared/threadLinks";

import * as ServerConfig from "../../../config.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { limitAutoResumeUpdate } from "../../../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as UsageLimitHandoff from "../../../orchestration-v2/UsageLimitHandoff.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const limitHandoffFailure = (error: UsageLimitHandoffError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "dispatch-failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) =>
      request.id === input.requestId &&
      request.kind === "user_input" &&
      request.status === "pending",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  return { ...context, request, item };
});
/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId: task.threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const { projectId: requested, ...query } = input;
      // Like the other project tools, an omitted project means the caller's own; a client
      // outside a thread searches every project.
      const projectId = requested ?? caller?.projectId;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      return {
        matches: result.matches
          .filter((match) => projectId === undefined || match.projectId === projectId)
          .map((match) => ({
            ...match,
            link: formatThreadLink(match.threadId, match.title ?? match.threadId),
          })),
      };
    }),
  ),
  thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
  ),
  thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  thread_limit_handoff_options: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { shell } = yield* readThread(input.threadId);
      const handoff = yield* UsageLimitHandoff.UsageLimitHandoffService;
      const recommendation = yield* handoff
        .recommend(shell.id)
        .pipe(Effect.mapError(limitHandoffFailure));
      return { recommendation };
    }),
  ),
  thread_limit_handoff: writesThread((input) =>
    Effect.gen(function* () {
      const { shell } = yield* readThread(input.threadId);
      if (shell.latestRunId === null) {
        return yield* limitHandoffFailure(
          new UsageLimitHandoffError({ threadId: shell.id, reason: "not-limited" }),
        );
      }
      const handoff = yield* UsageLimitHandoff.UsageLimitHandoffService;
      const result = yield* handoff
        .accept({
          threadId: shell.id,
          runId: shell.latestRunId,
          ...(input.providerInstanceId === undefined
            ? {}
            : { instanceId: input.providerInstanceId }),
          ...(input.model === undefined ? {} : { model: input.model }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(limitHandoffFailure));
      return {
        ...result,
        receipt: `Continuing on ${result.modelSelection.instanceId} (${result.modelSelection.model})`,
      };
    }),
  ),
  pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readQuestion(input);
      // A question is for the user, or for the thread that delegated the task.
      // A thread agent may not answer its own, or a sibling's or stranger's.
      // A client outside a thread acts for the user who approved it.
      if (caller !== undefined) {
        const { lineage } = projection.thread;
        if (projection.thread.id === caller.id)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A thread cannot answer its own question. The user answers it.",
          });
        if (lineage.parentThreadId !== caller.id || lineage.relationshipToParent !== "subagent")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the thread that delegated this task can answer its questions.",
          });
      }
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  queue_clear: writesThread((input) =>
    dispatch(input.threadId, (common) => ({ ...common, type: "queue.clear" })),
  ),
  queue_send_all: writesThread((input) =>
    dispatch(input.threadId, (common) => ({ ...common, type: "queue.send-all" })),
  ),
  thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, shell } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "resume_at_reset":
        case "dont_resume": {
          const limitRecovery = limitAutoResumeUpdate(shell, input.action === "resume_at_reset");
          if (limitRecovery === null) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The thread is not stopped on a usage limit with a reset time.",
            });
          }
          command = { ...common, type: "thread.metadata.update", limitRecovery };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  thread_snooze: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, shell, caller } = yield* readThread(input.threadId);
      const config = yield* ServerConfig.ServerConfig;
      const clock = {
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        timeZone: config.serverTimeZone,
      };
      let until: { readonly snoozedUntil: string } | "limit_reset" = "limit_reset";
      if (input.until.toLowerCase() !== "limit_reset") {
        const resolved = resolveSnoozeUntil(input.until, clock);
        if (!resolved.ok) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: resolved.message,
          });
        }
        until = { snoozedUntil: DateTime.formatIso(DateTime.makeUnsafe(resolved.atMs)) };
      }
      const result = yield* threads
        .snoozeThread({
          commandId: yield* newCommandId(),
          threadId: shell.id,
          until,
          byOwnAgent: caller?.id === shell.id,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementNoLimitResetError"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
              : dispatchFailure(error),
          ),
        );
      const wake = formatSnoozeTime(Date.parse(result.snoozedUntil), clock, { locale: "en-US" });
      return {
        ...result,
        timeZone: clock.timeZone,
        receipt:
          "snoozesWhenTurnEnds" in result
            ? `Snoozes until ${wake} when this turn ends`
            : `Snoozed until ${wake}`,
      };
    }),
  ),
  thread_unsnooze: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, shell } = yield* readThread(input.threadId);
      const result = yield* threads
        .unsnoozeThread({ commandId: yield* newCommandId(), threadId: shell.id })
        .pipe(Effect.mapError(dispatchFailure));
      return { ...result, receipt: "Woke the thread" };
    }),
  ),
  thread_settle: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, shell, caller } = yield* readThread(input.threadId);
      const result = yield* threads
        .settleThread({
          commandId: yield* newCommandId(),
          threadId: shell.id,
          byOwnAgent: caller?.id === shell.id,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return {
        ...result,
        receipt:
          "settlesWhenTurnEnds" in result ? "Settles when this turn ends" : "Settled the thread",
      };
    }),
  ),
  thread_unsettle: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, shell } = yield* readThread(input.threadId);
      const result = yield* threads
        .unsettleThread({ commandId: yield* newCommandId(), threadId: shell.id })
        .pipe(Effect.mapError(dispatchFailure));
      return { ...result, receipt: "Moved back to active" };
    }),
  ),
});
