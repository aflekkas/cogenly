import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  UsageLimitHandoffRecommendation,
} from "@t3tools/contracts";
import { SNOOZE_PRESET_KEYS } from "@t3tools/shared/snooze";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitHandoff from "../../../orchestration-v2/UsageLimitHandoff.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("thread_organize", {
  description:
    "Pin, archive, or mark a thread unread. Omit threadId for this thread. For a thread stopped on a usage limit (see usageLimit in thread_list or thread_read), dont_resume cancels its automatic continuation at the reset and resume_at_reset schedules it again. Snooze and settle have their own tools. Existing thread lifecycle rules apply.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "archive",
      "unarchive",
      "mark_unread",
      "resume_at_reset",
      "dont_resume",
    ]),
  }),
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Destructive, true);

/** Every lifecycle receipt: one line the timeline shows and the agent can quote. */
const lifecycleReceipt = { receipt: Schema.String };
const lifecycleTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const ThreadSnoozeTool = Tool.make("thread_snooze", {
  ...lifecycleTool,
  description: `Snooze a thread: hide it from the user's inbox until a time, as when they say "snooze this until tomorrow". Omit threadId for this thread. until is a preset (${SNOOZE_PRESET_KEYS.join(", ")}), limit_reset (until the usage limit the thread stopped on resets), an ISO time, or a short phrase such as "friday 2pm" or "in 2 days". Presets and phrases resolve in the user's time zone exactly as the snooze menu does. A snoozed thread wakes early when it asks for something, fails, or completes; snoozing this thread therefore lands when your turn completes (snoozesWhenTurnEnds=true). Quote the receipt instead of restating the time.`,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    until: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
  success: Schema.Struct({
    ...lifecycleReceipt,
    snoozedUntil: IsoDateTime,
    timeZone: Schema.String,
    sequence: Schema.optional(NonNegativeInt),
    snoozesWhenTurnEnds: Schema.optional(Schema.Literal(true)),
  }),
  dependencies: [...lifecycleTool.dependencies, ServerConfig.ServerConfig],
})
  .annotate(Tool.Title, "Snooze a thread")
  .annotate(Tool.Destructive, false);
const ThreadUnsnoozeTool = Tool.make("thread_unsnooze", {
  ...lifecycleTool,
  description:
    "Wake a snoozed thread now so it returns to the user's inbox. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ ...lifecycleReceipt, sequence: NonNegativeInt }),
})
  .annotate(Tool.Title, "Wake a thread")
  .annotate(Tool.Destructive, false);
const ThreadSettleTool = Tool.make("thread_settle", {
  ...lifecycleTool,
  description:
    "Settle a thread: move it out of the active list once its work is done. Omit threadId for this thread. Settling this thread takes effect when your turn completes, returning settlesWhenTurnEnds=true; a turn that fails or is interrupted, or a queued message, leaves it active.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    ...lifecycleReceipt,
    sequence: Schema.optional(NonNegativeInt),
    settlesWhenTurnEnds: Schema.optional(Schema.Literal(true)),
  }),
})
  .annotate(Tool.Title, "Settle a thread")
  .annotate(Tool.Destructive, false);
const ThreadUnsettleTool = Tool.make("thread_unsettle", {
  ...lifecycleTool,
  description: "Return a settled thread to the user's active list. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ ...lifecycleReceipt, sequence: NonNegativeInt }),
})
  .annotate(Tool.Title, "Unsettle a thread")
  .annotate(Tool.Destructive, false);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QueueListTool = Tool.make("queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. Results are a live offset page; use thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message. Omit threadId for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);
const QueueClearTool = Tool.make("queue_clear", {
  ...commandTool,
  description:
    "Remove every message the user queued on a thread in one step. Automatic task deliveries stay queued. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
}).annotate(Tool.Destructive, true);
const QueueSendAllTool = Tool.make("queue_send_all", {
  ...commandTool,
  description:
    "Join every queued message, in queue order, into one message and send it now: as steering into the running turn when its provider can steer, otherwise as the next turn. Releases a held queue. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
}).annotate(Tool.Destructive, true);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread. Omit threadId for this thread. Approval requests are not included.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question. Answer with pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("pending_request_respond", {
  ...commandTool,
  description:
    "Answer a pending user-input request in a task you delegated, using the existing runtime response command. Questions in your own thread are for the user. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadConfigurationTool = Tool.make("thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes. Omit threadId for this thread. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model and options with the existing selection command. Omit threadId for this thread. This does not change permission modes. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const limitHandoffTool = {
  ...commandTool,
  dependencies: [...commandTool.dependencies, UsageLimitHandoff.UsageLimitHandoffService],
};
const ThreadLimitHandoffOptionsTool = Tool.make("thread_limit_handoff_options", {
  ...limitHandoffTool,
  description:
    "For a thread stopped on a usage limit (usageLimit in thread_list or thread_read), list the provider instances that could continue it, best first: known headroom before unknown, the same provider before another, the same model before a fallback. Each candidate carries its usage. recommendation is null when the thread is not stopped on a usage limit; an empty candidates list means nothing else can run it now. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ recommendation: Schema.NullOr(UsageLimitHandoffRecommendation) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadLimitHandoffTool = Tool.make("thread_limit_handoff", {
  ...limitHandoffTool,
  description:
    "Continue a thread stopped on a usage limit on another provider instance: switches the thread, hands its context over, and re-runs the stopped request, cancelling any resume scheduled for the reset. Omit providerInstanceId to take the top candidate from thread_limit_handoff_options; model defaults to the candidate's. Switch only when the user asked you to manage usage or approved the switch.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    providerInstanceId: Schema.optional(ProviderInstanceId),
    model: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    sequence: Schema.Number,
    modelSelection: ModelSelection,
    receipt: Schema.String,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("thread_fork", {
  ...commandTool,
  description:
    "Fork a conversation, leaving the original unchanged. Omit threadId for this thread. Use a stable clientRequestId across retries. Set machine to this, vps, auto, a machine name or ID to fork on a paired machine in the same repository, cloned there on demand. Cross-machine forks use a portable context handoff and the source's pushed branch/commit. If uncommitted or unpushed work is reported, tell the user and obtain their choice before retrying with allowLastPushed:true; those changes remain on the source. Omit sourcePoint to use the latest finished turn for a cross-machine fork. Acceptance does not start a provider turn.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    clientRequestId: Schema.optional(TrimmedNonEmptyString),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    machine: Schema.optional(TrimmedNonEmptyString),
    allowLastPushed: Schema.optional(Schema.Boolean),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    ...transferResult.fields,
    branch: Schema.optional(Schema.NullOr(Schema.String)),
    commit: Schema.optional(Schema.NullOr(Schema.String)),
    usedLastPushed: Schema.optional(Schema.Boolean),
  }),
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from a thread back to a related thread in the same project. Omit sourceThreadId to merge from this thread. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadTransfersTool = Tool.make("thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("thread_search", {
  ...commandTool,
  description:
    "Search active thread titles and content with the app's existing bounded search. Each match carries a Markdown `link` to the thread; when you mention it to the user, write that link as is. Matches are limited to one project (projectId, else the calling thread's project) out of the global top matches, so this may return fewer than limit. A caller outside a Cogenly thread that omits projectId searches every project. No pagination or exhaustive-result guarantee.",
  parameters: Schema.Struct({
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({ ...OrchestrationThreadSearchMatch.fields, link: Schema.String }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadToolkit = Toolkit.make(
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  ThreadLimitHandoffOptionsTool,
  ThreadLimitHandoffTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  ThreadSnoozeTool,
  ThreadUnsnoozeTool,
  ThreadSettleTool,
  ThreadUnsettleTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
  QueueClearTool,
  QueueSendAllTool,
);
