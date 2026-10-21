import {
  AgentBuilderStartInput,
  AgentBuilderStartResult,
  AgentListResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
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
const List = Tool.make("list_agents", {
  ...shared,
  description: "List persistent agents with their unread counts and latest messages.",
  parameters: Tool.EmptyParams,
  success: AgentListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BuilderStart = Tool.make("start_agent_builder", {
  ...shared,
  description:
    "Start an agent-builder conversation from a request. The builder drafts its proposal in the new thread and the owner confirms it on the proposal card; this never creates an agent directly.",
  parameters: AgentBuilderStartInput,
  success: AgentBuilderStartResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const toolkit = Toolkit.make(List, BuilderStart);
const hasMessage = (cause: unknown): cause is { message: string } =>
  typeof cause === "object" && cause !== null && "message" in cause;
const unavailable = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: hasMessage(cause) ? cause.message : "Could not reach agent management.",
  });
export const handlers = Access.toLayer(toolkit, {
  list_agents: Access.reads(() =>
    Effect.gen(function* () {
      return yield* (yield* Service.AgentService).list().pipe(Effect.mapError(unavailable));
    }),
  ),
  // A builder is a conversation, not a work session, so chats may start one;
  // the agent itself is only created when the owner confirms the proposal card.
  // The builder always runs full-access/default, so narrower callers are refused.
  start_agent_builder: Access.startsThreads(
    () => ({ interactionMode: "default" as const }),
    (input) =>
      Effect.gen(function* () {
        return yield* (yield* Service.AgentService)
          .builderStart(input)
          .pipe(Effect.mapError(unavailable));
      }),
  ),
});
