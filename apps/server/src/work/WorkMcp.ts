import {
  CommandId,
  OrchestratorMcpFailure,
  ProjectId,
  WorkStartInput,
  WorkStartResult,
  WorkTaskBrief,
  WorkTaskHandoffResult,
  WorkTaskMode,
  WorkTaskWorkspace,
  WorkHandoffDraft,
  WorkScopeSummary,
  WorkTitle,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { resolveMachine } from "../machines/resolveMachine.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Work from "./WorkHandoffService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Work.WorkHandoffService,
    Threads.ThreadManagementService,
    Invocation.McpInvocationContext,
  ],
};
const Start = Tool.make("work_start", {
  ...shared,
  description:
    "Start a normal coding Work session from this conversation in the chosen repository, with a concise approved scope and source link. Defaults to a new worktree when the repository uses git, else its checkout. Pass throughMessageId to hand off only the conversation up to that message. Reuse commandId when retrying. Agent identity comes from the calling thread.",
  parameters: Schema.Struct({
    machine: Schema.optional(TrimmedNonEmptyString),
    commandId: WorkStartInput.fields.commandId,
    targetProjectId: WorkStartInput.fields.targetProjectId,
    // An agent writes its own title and scope; only the web hands off the raw chat.
    title: WorkTitle,
    scopeSummary: WorkScopeSummary,
    workspace: WorkStartInput.fields.workspace,
    modelSelection: WorkStartInput.fields.modelSelection,
    throughMessageId: WorkStartInput.fields.throughMessageId,
  }),
  success: WorkStartResult,
});
const Propose = Tool.make("work_propose_handoff", {
  ...shared,
  description:
    "Draft an editable Work title, scope and repository suggestion from this conversation, or from it up to throughMessageId. Does not launch Work.",
  parameters: Schema.Struct({
    throughMessageId: WorkStartInput.fields.throughMessageId,
  }),
  success: WorkHandoffDraft,
});
/**
 * The one way a chat's agent gets changes made: it hands them to a task, a new
 * top-level Work thread the user sees, shown as a card in the chat. Unlike
 * work_start it serves chat callers, since the card keeps the user in charge,
 * and the result comes back to the chat as a notification turn.
 */
const Task = Tool.make("work_task", {
  ...shared,
  description:
    "Hand a request that changes code, files or this machine, or that runs long, to a new Work task: a top-level coding thread the user can see and follow, with its own project or machine environment, shown as a task card in this chat. Do not use it for lookups the chat can run itself. It is not a subagent; the task runs on its own and its result comes back to this chat as a notification, so never poll it. mode=propose shows the card with Approve, Edit and Dismiss and starts nothing; mode=start launches at once. Use start only when the user explicitly asked for this action and it is unambiguous and low-risk, or clearly instructed destructive work such as uninstalling or deleting; otherwise propose. Pick targetProjectId from project_list when the work belongs to one of the user's projects; omit it for work on this machine itself, such as installing or uninstalling apps, which runs in No project. Write brief as complete instructions for the task agent: the goal, what to do, constraints, and what done looks like. Pass settleWhenDone=true for a self-contained task whose reported result is all the user needs (no PR or diff to review), so its Work thread settles once it completes instead of lingering; a failed task stays active. Omit modelSelection to use this chat's model. Reuse commandId when retrying.",
  parameters: Schema.Struct({
    commandId: WorkStartInput.fields.commandId,
    machine: Schema.optional(TrimmedNonEmptyString),
    mode: WorkTaskMode,
    title: WorkTitle,
    brief: WorkTaskBrief,
    targetProjectId: Schema.optional(ProjectId),
    workspace: Schema.optional(WorkTaskWorkspace),
    modelSelection: WorkStartInput.fields.modelSelection,
    settleWhenDone: Schema.optional(Schema.Boolean),
  }),
  success: WorkTaskHandoffResult,
});
export const toolkit = Toolkit.make(Start, Propose, Task);
const source = Invocation.McpInvocationContext.pipe(
  Effect.flatMap((scope) => Invocation.requireThreadScope(scope, "Work handoff")),
);
export const handlers = Access.toLayer(toolkit, {
  work_propose_handoff: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* source;
      const work = yield* Work.WorkHandoffService;
      return yield* work
        .proposeHandoff(scope.thread.threadId, { throughMessageId: input.throughMessageId })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  work_task: Access.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const scope = yield* source;
        const { caller } = yield* readCaller();
        const work = yield* Work.WorkHandoffService;
        return yield* work
          .handoffTask(
            {
              ...input,
              machine: yield* resolveMachine(input.machine).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
                ),
              ),
              commandId: CommandId.make(`work-task:${scope.requestNamespace}:${input.commandId}`),
              sourceThreadId: scope.thread.threadId,
              runId: caller?.activeRunId ?? undefined,
            },
            { origin: "chat", createdByAgent: true, ...modes },
          )
          .pipe(Effect.mapError(unavailable));
      }),
  ),
  work_start: Access.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const scope = yield* source;
        const { caller } = yield* readCaller();
        yield* Access.assertWorkCaller(caller);
        const sourceAgentRunId = caller?.sourceAgentRunId ?? caller?.activeRunId ?? undefined;
        const work = yield* Work.WorkHandoffService;
        return yield* work
          .start(
            {
              ...input,
              machine: yield* resolveMachine(input.machine).pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
                ),
              ),
              commandId: CommandId.make(`work:${scope.requestNamespace}:${input.commandId}`),
              sourceThreadId: scope.thread.threadId,
            },
            {
              origin: "agent",
              ...modes,
              ...(caller?.agent === undefined ? {} : { sourceAgentId: caller.agent.id }),
              ...(sourceAgentRunId === undefined ? {} : { sourceAgentRunId }),
            },
          )
          .pipe(Effect.mapError(unavailable));
      }),
  ),
});
