import {
  ScheduledTaskId,
  ScheduledTaskFields,
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
} from "@cogenly/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("thread_organize", {
  description:
    "Pin/archive/mark unread. threadId defaults here. For usageLimit stops, dont_resume cancels automatic reset continuation; resume_at_reset restores it. Snooze/settle use separate tools.",
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
  description:
    "Hide from inbox until a preset (in_1h/in_3h/this_evening/tomorrow/next_week), limit_reset, ISO time or phrase in user time zone. threadId defaults here. Requests/failure/completion wake early; snoozing this thread lands after this turn. Quote receipt instead of restating time.",
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
    "Move finished work out of active list. threadId defaults here. This thread settles at turn end; failure/interruption/queued input keeps it active (settlesWhenTurnEnds:true).",
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
    "Send a queued message now: steer the active turn, or start a turn when idle. targetRunId is optional.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: Schema.optional(RunId) }),
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
    "Join queued messages in order and send now as steer if supported, otherwise next turn. Releases held queue. threadId defaults here.",
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
    "Answer user-input in a delegated child; own-thread questions belong to the user. Cannot grant permissions.",
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
    "Set provider/model/options using orchestrator_capabilities; leaves permissions unchanged. threadId defaults here.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("thread_fork", {
  ...commandTool,
  description:
    "Fork without changing source; threadId defaults here. Reuse clientRequestId on retries. machine selects a peer and clones on demand, using portable context and pushed commit. For uncommitted/unpushed work obtain user choice before allowLastPushed:true; work stays on source. Cross-machine sourcePoint defaults latest finished turn. Does not start a turn.",
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
    "Merge context into a related same-project thread under lineage/transfer rules. sourceThreadId defaults here.",
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
    "Search active titles/content within projectId (default here). Filters global top matches, so may return fewer than limit; no exhaustive pagination. Outside callers omitting project search all. Use returned Markdown links.",
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
    "Dispatch one manual run (no retry key), requiring full-access/default. Completion confirms scheduler bookkeeping, not provider completion.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTaskFields.threadId,
    lastRunStatus: ScheduledTaskFields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTaskFields.nextRunAt,
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
