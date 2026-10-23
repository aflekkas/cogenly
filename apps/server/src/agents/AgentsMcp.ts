import {
  AgentBuilderStartInput,
  AgentBuilderStartResult,
  AgentListItem,
  AgentMutationResult,
  AgentSetProjectInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
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
/** The agents list with each agent's project named, so a conversation can organize by name. */
const AgentsWithProjects = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({ ...AgentListItem.fields, projectName: Schema.NullOr(Schema.String) }),
  ),
});
const List = Tool.make("list_agents", {
  ...shared,
  dependencies: [...shared.dependencies, Labels.ProjectLabelService],
  description:
    "List persistent agents with their project (projectFolderId and projectName, null when unfiled), unread counts and latest messages.",
  parameters: Tool.EmptyParams,
  success: AgentsWithProjects,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BuilderStart = Tool.make("start_agent_builder", {
  ...shared,
  description:
    "Start an agent-builder conversation from a request. Pass projectFolderId (from project_label_list) to start it in a project; the proposed agent lands there. The builder drafts its proposal in the new thread and the owner confirms it on the proposal card; this never creates an agent directly.",
  parameters: AgentBuilderStartInput,
  success: AgentBuilderStartResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const SetProject = Tool.make("update_agent_project", {
  ...shared,
  description:
    "Move a persistent agent into a project folder (projectFolderId from project_label_list), or null for no project. Its one conversation moves with it in place, without forking, and then runs in the project directory with the project's files.",
  parameters: AgentSetProjectInput,
  success: AgentMutationResult,
}).annotate(Tool.Destructive, false);
export const toolkit = Toolkit.make(List, BuilderStart, SetProject);
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
      const { agents } = yield* (yield* Service.AgentService)
        .list()
        .pipe(Effect.mapError(unavailable));
      const { labels } = yield* (yield* Labels.ProjectLabelService)
        .list()
        .pipe(Effect.mapError(unavailable));
      const names = new Map(labels.map((label) => [label.id, label.name]));
      return {
        agents: agents.map((agent) => ({
          ...agent,
          projectName:
            agent.projectFolderId === null ? null : (names.get(agent.projectFolderId) ?? null),
        })),
      };
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
  // Mutating, and off the conversation auto-approve list, so the owner
  // confirms each move. Persistent agents may only move themselves.
  update_agent_project: Access.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* Service.AgentService)
        .setProject(input)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
});
