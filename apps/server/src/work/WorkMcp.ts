import {
  CommandId,
  OrchestratorMcpFailure,
  WorkStartInput,
  WorkStartResult,
  WorkHandoffDraft,
  WorkScopeSummary,
  WorkTitle,
} from "@t3tools/contracts";
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
export const toolkit = Toolkit.make(Start, Propose);
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
  work_start: Access.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const scope = yield* source;
        const { caller } = yield* readCaller();
        const sourceAgentRunId = caller?.sourceAgentRunId ?? caller?.activeRunId ?? undefined;
        const work = yield* Work.WorkHandoffService;
        return yield* work
          .start(
            {
              ...input,
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
