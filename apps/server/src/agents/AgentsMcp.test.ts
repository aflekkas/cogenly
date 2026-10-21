import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Service from "./AgentService.ts";
import * as AgentsMcp from "./AgentsMcp.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

it.effect("lists agents even for a read-only client", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        capabilities: new Set(["orchestration" as const]),
        requestNamespace: "test",
        issuedAt: 0,
        thread: undefined,
        client: { sessionId: "session", label: "Agent", access: "read-only" as const },
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      }),
      Layer.mock(Service.AgentService)({
        list: () => Effect.succeed({ agents: [] }),
      }),
    );
    const toolkit = yield* AgentsMcp.toolkit.pipe(
      Effect.provide(
        Access.HandlersLayer.layer(AgentsMcp.handlers).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle("list_agents", {})
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(results.at(-1)?.result).toMatchObject({ agents: [] });
  }),
);

it.effect.each([
  { interactionMode: "default" as const, code: undefined },
  { interactionMode: "plan" as const, code: "interaction_mode_escalation_denied" },
])(
  "starts a builder for a $interactionMode thread caller, refusing narrower modes",
  ({ interactionMode, code }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:builder-starter");
      const shell = liveThreadShell(threadId, { interactionMode });
      const started: Array<string> = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          capabilities: new Set(["orchestration" as const]),
          requestNamespace: "test",
          issuedAt: 0,
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: shell.providerInstanceId,
          },
          client: undefined,
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
        }),
        Layer.mock(Service.AgentService)({
          builderStart: (input) =>
            Effect.sync(() => {
              started.push(input.text);
              return {
                threadId: ThreadId.make("agent-builder:started"),
                projectId: ProjectId.make("project:mcp-test"),
              };
            }),
        }),
      );
      const toolkit = yield* AgentsMcp.toolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(AgentsMcp.handlers).pipe(Layer.provide(dependencies)),
        ),
      );
      const results = yield* toolkit
        .handle("start_agent_builder", { text: "Watch my pull requests", modelSelection })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      if (code) {
        expect(results.at(-1)?.result).toMatchObject({ code });
        expect(started).toEqual([]);
      } else {
        expect(results.at(-1)?.result).toMatchObject({ threadId: "agent-builder:started" });
        expect(started).toEqual(["Watch my pull requests"]);
      }
    }),
);
