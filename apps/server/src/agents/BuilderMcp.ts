import { AgentBuilderProposal, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Service from "./AgentService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Service.AgentService,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
const Propose = Tool.make("propose_agent", {
  ...shared,
  description:
    "Replace this builder thread's agent proposal with the whole current one. Only builder threads may call it; the client renders the latest call as the proposal card.",
  parameters: AgentBuilderProposal,
  success: AgentBuilderProposal,
});
export const toolkit = Toolkit.make(Propose);
const hasMessage = (cause: unknown): cause is { message: string } =>
  typeof cause === "object" && cause !== null && "message" in cause;
const unavailable = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: hasMessage(cause) ? cause.message : "Could not update the agent proposal.",
  });
export const handlers = Access.toLayer(toolkit, {
  propose_agent: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      if (scope.thread === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "propose_agent needs a builder thread.",
        });
      const { proposal } = yield* (yield* Service.AgentService)
        .recordProposal({ threadId: scope.thread.threadId, proposal: input })
        .pipe(Effect.mapError(unavailable));
      return proposal;
    }),
  ),
});
