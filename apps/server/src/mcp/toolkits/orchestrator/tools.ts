import {
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpRequestLoginInput,
  OrchestratorMcpRequestLoginResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@cogenly/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

// Keep the shared wire shape while describing standalone server webhooks.
const ScheduledTaskResult = OrchestratorMcpScheduleTaskResult.mapFields((fields) => ({
  ...fields,
  webhookUrl: fields.webhookUrl.annotate({
    description:
      "Webhook URL at this MCP server's origin. Only callers allowed to run the task receive it. Use a reachable HTTPS origin for external senders.",
  }),
}));

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "Read the live provider/model catalog, custom models, inherited settings and available orchestration. Subscription usage includes state, tightest remainingPercent, window resets and stale (>30m). Paired machines carry optional cached resources (cores, load, memory, disk, active work) for placement and pacing; online ones carry their own catalog or catalogError; use their IDs with delegation/launch tools.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Run a child with only the supplied prompt, no parent history. Choose catalog models via orchestrator_capabilities. isolation:worktree starts from the parent local commit with setup, excluding uncommitted edits; default shares checkout. Settings inherit unless overridden; children have full access (runtimeMode deprecated). Prefer async; completion notifies this parent. wait stops on result/question/timeout without cancelling: retain taskId on waitTimedOut. hasPendingQuestion: use pending_request_list/read/respond with childThreadId or ask the user. Follow orchestration rules for review rounds; task_status is for results needed mid-turn.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read this parent's delegated task. workState distinguishes active work/nested children/result availability; summary is stable after publication. hasPendingChildRuns reports later queued/executing child turns (excluding stopped holds), without reopening terminal tasks; latestTerminal* reports later non-monitor results. Reading terminal results acknowledges delivery. Remote worktree results fetch without force into branch; branchError explains failures.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Stop a delegated task, its later child turns and descendants; hold queues, end PR watches and cancel automatic parent delivery. Terminal status and published results remain readable.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const WorkflowStopTool = Tool.make("workflow_stop", {
  description:
    "Stop a whole Claude workflow by its activity-view subagentId, including phases/agents. Leaves parent/other workflows running; individual phases cannot stop separately.",
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create recurring or webhook work even while idle. Schedule is an object; see orchestration examples. Prompt placeholders expose {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} (credentials redacted). Signed webhooks use a one-use request_secret secretRef in signature. webhookUrl uses this server origin and is visible only to authorized callers; external senders need reachable HTTPS. projectId defaults here; bindToCurrentThread defaults true here, false for another project. Provider/model/runtime inherit caller or project defaults. Report cadence/nextRunAt or webhookUrl.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: ScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List schedules, prompts, enabled/bound state, next run and last status. projectId defaults here, or all projects outside threads. Use IDs to update/delete.",
  success: Schema.Struct({ tasks: Schema.Array(ScheduledTaskResult) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Patch schedule fields by scheduledTaskId; omitted fields stay. enabled:false pauses. bindToCurrentThread switches between this thread and fresh runs.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: ScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete and stop a scheduled task by ID. For reversible pause use update_scheduled_task enabled:false.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Collect a secret privately, never returning its value. Pass the single-use secretRef to a consuming tool. For account_connect, saveToAccount:{connectionId} uses server-fixed service/scope and returns account/credential IDs instead. Cards persist after timeout and notify this thread on answer; follow vault waiting rules.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const RequestLoginTool = Tool.make("request_login", {
  description:
    "Collect a missing/rejected site login via a private card into the vault. First check vault_list. Fill the returned vaultItemId; updateItemId replaces an existing login. Declined means continue without it. Cards persist after timeout and notify on answer; follow vault waiting rules.",
  parameters: OrchestratorMcpRequestLoginInput,
  success: OrchestratorMcpRequestLoginResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user to sign in")
  .annotate(Tool.Destructive, false);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Batch explicitly requested top-level conversations sharing this project/branch/worktree. Per-entry provider/model/options/modes inherit unless overridden. For a single conversation or separate checkout use thread_launch; for children use delegate_task.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create Cogenly threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("thread_list", {
  description:
    "List project threads newest first, filtered by run/title/settled/snoozed state with cursor pagination. projectId defaults here. Snoozes wake on requests, failure or completion. Use each returned Markdown link when mentioning threads.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Cogenly threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("thread_read", {
  description:
    "Read state/timeline in this environment. messages (default) includes user/assistant/plans; activity includes all summaries. Defaults: 20 items, 2,000 chars/item. Page with afterPosition=nextPosition; recover text with itemId/textOffset=nextTextOffset (UTF-16) until null. Untruncated direct-child terminal results acknowledge delivery. Includes snooze and Markdown link.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a Cogenly thread")
  // Strict so a misspelled paging param fails instead of silently reading from position 0.
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUpdateTool = Tool.make("thread_update", {
  description:
    "Update thread metadata (threadId defaults here): rename+title, regenerate_title, link_pull_request+pullRequest or unlink_pull_request. No workspace/branch changes. Reuse clientRequestId on retries.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update Cogenly thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("thread_send", {
  description:
    "Send to a thread with at most caller permissions. clientRequestId makes retries idempotent. mode:auto steers, starts idle, otherwise queues (recommended); steer interrupts for urgent corrections; queue waits until turn end; restart interrupts and restarts.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a Cogenly thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("thread_wait", {
  description:
    "Wait for a durable terminal run (default latest; idle returns immediately). Timeout does not stop work; retry/read after timedOut. Status only, no delegated-result acknowledgment.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a Cogenly thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("thread_interrupt", {
  description:
    "Interrupt the named run or newest interruptible run in a thread. Terminal/idle calls are harmless. Reuse clientRequestId on retries.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a Cogenly thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  WorkflowStopTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  RequestLoginTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
