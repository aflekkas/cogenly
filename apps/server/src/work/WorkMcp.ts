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
} from "@cogenly/contracts";
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
    "Start approved coding scope in chosen repo with source link. Defaults to new Git worktree, otherwise checkout. throughMessageId bounds handoff; reuse commandId on retries. Identity comes from caller.",
  parameters: Schema.Struct({
    machine: Schema.optional(TrimmedNonEmptyString),
    commandId: WorkStartInput.fields.commandId,
    targetProjectId: WorkStartInput.fields.targetProjectId,
    projectFolderId: WorkStartInput.fields.projectFolderId,
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
    "Hand changes or long work to a top-level Work task, never chat lookups. Result notifies this chat; do not poll. start only for explicit, unambiguous low-risk work or explicitly requested destruction; otherwise propose shows an approval card. targetProjectId chooses a project, omitted means this machine/No project. brief must include goal, constraints and done criteria. settleWhenDone:true for results needing no PR/diff review (failures stay active). Model defaults to chat; reuse commandId on retries.",
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
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: cause.message,
                }),
            ),
          );
      }),
  ),
});
