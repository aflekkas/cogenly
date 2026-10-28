import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpInputRequestUpdateInput,
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
    "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this caller. Each subscription provider carries usage: state (available, exhausted, unknown), remainingPercent of its tightest window, each window's usedPercent and resetsAt, and stale when the reading is over 30 minutes old. machines lists each paired machine; an online one carries its own provider instances in catalog (or catalogError), the ids to pass to delegate_task or create_threads with that machine. For a separate top-level thread in a new or existing worktree, use thread_launch with workspaceStrategy.",
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
    "Needs an agent running inside a Cogenly thread. Delegate one task to a Cogenly-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Choose providers and models from orchestrator_capabilities, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly Cogenly-owned child tasks. For every Cogenly delegated review round, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt. Track each round by its own taskId and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through thread_send. Set isolation to worktree for a separate checkout based on the parent local commit, with project setup completed before the child starts. Uncommitted edits are not copied; omitted isolation shares the parent checkout. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. All children run with full access; runtimeMode is a deprecated compatibility field. Prefer mode='async' for long work; mode='wait' blocks until completion, a blocking question, or timeout. If hasPendingQuestion, pass threadId=childThreadId to pending_request_list, pending_request_read (with requestId) and pending_request_respond, or ask the user; the task's completion still wakes this thread. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
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
    "Needs an agent running inside a Cogenly thread. Read a Cogenly-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count. latestTerminal* provides later non-monitor turn results. Reading a terminal result acknowledges its automatic parent delivery. For a remote worktree task, it also fetches its committed result branch into this machine's clone without force; branch names the received branch, or branchError explains why it remains on the target.",
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
    "Needs an agent running inside a Cogenly thread. Stop a Cogenly-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, queued turns are held, pull request watches end, and the tasks it delegated stop too. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
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
    "Stop one running Claude workflow in a Cogenly thread. Use the workflow coordinator's subagentId returned by thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
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
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings; report the returned nextRunAt. Webhooks: {type:'webhook'} runs once per request to a generated URL. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. The result's webhookUrl uses this MCP server's origin. For external senders, connect to Cogenly through your own reachable HTTPS proxy and share that URL; loopback addresses only work on this machine. The URL is shown only to callers allowed to run the task. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Provider, model, and runtime settings inherit from this thread, or from the project default when there is no calling thread.",
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
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
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
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
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
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
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
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. schedule_task's signature.secretRef). It works once. For an account_connect pending connection, pass saveToAccount: {connectionId}; service, project, credential kind and use are fixed server-side, and the result returns account/credential ids instead of a secretRef. The tool wait is bounded; the card persists until answered or cancelled and its answer automatically notifies this thread. Say you are waiting on the card; do not ask the user to type continue. Never ask for secrets in chat, and never invent one.",
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
    "Ask the user to sign in to a site through a login card in this thread, and wait for them to answer. Use it when a page needs a login and vault_list has none for that site: never ask for usernames, passwords or codes in chat. The user's answer goes straight into the vault as a login allowed on that site; you never see it. When saved, sign in with vault_fill using the returned vaultItemId (username, password, and totp when asked for). If a stored login stops working (e.g. the password changed), call again with updateItemId to replace its secrets. declined means the user chose not to; continue without it rather than asking again unprompted. The tool wait is bounded but the card persists until answered or cancelled. Its answer automatically notifies this thread. Say you are waiting on the card; never ask the user to type continue.",
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
    "Needs an agent running inside a Cogenly thread. Create one or more ORDINARY TOP-LEVEL Cogenly conversations. This is not delegation and does not create child agents/subagents. For delegated work, choose models from orchestrator_capabilities. Prefer native subagents only when they support the chosen model; otherwise call delegate_task, including for same-provider work. Use create_threads for a batch of separate top-level threads sharing this checkout. Prefer thread_launch for a single thread. Both require the user to request separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden here. For independent implementation or a PR stack in its own worktree, use thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt.",
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
    "List Cogenly threads in a project, newest first. Omit projectId for the calling thread's project. Filter by durable run status, title, or settled state (settled=true lists threads moved out of the active list), or snoozed state, and paginate with the returned cursor. A snoozed thread wakes early when it asks for something, fails, or completes. Each thread carries a Markdown `link`; when you mention it to the user, write that link as is. Cogenly opens it in the app and shows the thread's current title.",
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
    "Read durable state and a paginated timeline from any Cogenly thread in this environment. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Without explicit paging a call returns at most 20 items at 2,000 characters each; pass limit/maxCharsPerItem and continue with afterPosition=nextPosition only when you need more. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. The thread also reports its snooze state. Each thread carries a Markdown `link`; when you mention it to the user, write that link as is. Cogenly opens it in the app and shows the thread's current title.",
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
    "Update metadata for a thread. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, or action='unlink_pull_request'. Workspace and branch changes are intentionally not supported. clientRequestId makes retries idempotent.",
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
  description: [
    "Send to a Cogenly thread; the target cannot have broader permission modes than the caller. clientRequestId makes retries idempotent.",
    "auto (recommended): steer an active, steerable target, start an idle thread, or queue otherwise.",
    "steer: the target sees the message mid-turn, right away. Use for corrections and course changes needed now; it interrupts reasoning and can derail work if overused.",
    "queue: run after the current turn without disturbing work. Use for new tasks or results that can wait; a busy target may not see it for a long time. restart: interrupt and restart the active turn.",
  ].join("\n"),
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
    "Wait for a Cogenly thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
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
    "Request interruption of a running turn in any Cogenly thread in this environment. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a Cogenly thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  Tool.make("input_request_update", {
    description: "Skip, reopen, or explicitly keep an inline input request open in this thread. Get turnItemId from thread_read. Use skip when doing the work yourself or when the input is no longer needed. Unanswered requests are skipped at turn end unless keep_open was set. A skipped card must be reopened before answering; its old answer cannot wake abandoned work.",
    parameters: OrchestratorMcpInputRequestUpdateInput,
    success: Schema.Struct({}),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }),
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
