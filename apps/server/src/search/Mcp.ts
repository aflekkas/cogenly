import { OrchestratorMcpFailure, SearchQueryInput, SearchQueryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Search from "./GlobalSearch.ts";

export const toolkit = Toolkit.make(
  Tool.make("search", {
    description:
      "Search chats, Work, agents, facts, commitments, projects and linked PRs. Results are ranked by text relevance and recency. Label filters never expand your authorized scope.",
    parameters: SearchQueryInput,
    success: SearchQueryResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Search.GlobalSearch,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
export const handlers = Access.toLayer(toolkit, {
  search: Access.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* Search.GlobalSearch).query(input, scope).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not search this workspace.",
            }),
        ),
      );
    }),
  ),
});
