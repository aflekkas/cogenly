import { expect, it } from "@effect/vitest";
import {
  AgentId,
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  type Agent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import * as Service from "./AgentService.ts";
import * as AgentsMcp from "./AgentsMcp.ts";
import { agentFixture } from "./agent.testkit.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const folderId = ProjectLabelId.make("label:spawn");
const filed: Agent = { ...agentFixture("filed"), projectFolderId: folderId };
const listItem = (agent: Agent) => ({ ...agent, unreadCount: 0, latestMessage: null });
const clientScope = (access: "read-only" | "full-access") =>
  Layer.succeed(Invocation.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment"),
    capabilities: new Set(["orchestration" as const]),
    requestNamespace: "test",
    issuedAt: 0,
    thread: undefined,
    client: { sessionId: "session", label: "Agent", access },
  });
const organizer = (access: "read-only" | "full-access", moves: Array<unknown>) =>
  Layer.mergeAll(
    clientScope(access),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    }),
    Layer.mock(Labels.ProjectLabelService)({
      list: () =>
        Effect.succeed({
          labels: [
            {
              id: folderId,
              name: "Spawn Partners",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              repositoryIds: [],
              sourceLinks: [],
              threadCount: 0,
              instructions: "",
              projectChatThreadId: null,
            },
          ],
        }),
    }),
    Layer.mock(Service.AgentService)({
      update: (input) =>
        Effect.sync(() => {
          moves.push(input);
          return { agent: { ...filed, instructions: input.instructions ?? filed.instructions } };
        }),
      delete: (id) =>
        Effect.sync(() => {
          moves.push(id);
          return { deleted: true };
        }),
      list: () => Effect.succeed({ agents: [listItem(filed), listItem(agentFixture("loose"))] }),
      setProject: (input) =>
        Effect.sync(() => {
          moves.push(input);
          return { agent: { ...filed, projectFolderId: input.projectFolderId } };
        }),
    }),
  );
const run = (
  dependencies: ReturnType<typeof organizer>,
  name: "list_agents" | "update_agent_project" | "update_agent" | "delete_agent",
  args: object,
) =>
  Effect.gen(function* () {
    const toolkit = yield* AgentsMcp.toolkit.pipe(
      Effect.provide(
        Access.HandlersLayer.layer(AgentsMcp.handlers).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle(name, args as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result;
  });

it.effect("lists agents with their project names, even for a read-only client", () =>
  Effect.gen(function* () {
    const result = yield* run(organizer("read-only", []), "list_agents", {});
    expect(result).toMatchObject({
      agents: [
        { id: filed.id, projectFolderId: folderId, projectName: "Spawn Partners" },
        { id: AgentId.make("agent:loose"), projectFolderId: null, projectName: null },
      ],
    });
  }),
);

it.effect("moves an agent between projects as a mutating tool, refusing read-only clients", () =>
  Effect.gen(function* () {
    const refused: Array<unknown> = [];
    expect(
      yield* run(organizer("read-only", refused), "update_agent_project", {
        id: filed.id,
        projectFolderId: null,
      }),
    ).toMatchObject({ code: "capability_denied" });
    expect(refused).toEqual([]);
    const moves: Array<unknown> = [];
    expect(
      yield* run(organizer("full-access", moves), "update_agent_project", {
        id: filed.id,
        projectFolderId: null,
      }),
    ).toMatchObject({ agent: { id: filed.id, projectFolderId: null } });
    expect(moves).toEqual([{ id: filed.id, projectFolderId: null }]);
    const tool = AgentsMcp.toolkit.tools.update_agent_project;
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(false);
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

it.effect("owner management tools edit and delete through the agent service", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const layer = organizer("full-access", writes);
    expect(
      yield* run(layer, "update_agent", { id: filed.id, instructions: "Watch CI" }),
    ).toMatchObject({ agent: { instructions: "Watch CI" } });
    expect(yield* run(layer, "delete_agent", { id: filed.id })).toEqual({ deleted: true });
    expect(writes).toEqual([{ id: filed.id, instructions: "Watch CI" }, filed.id]);
  }),
);
it.effect("read-only management clients cannot mutate agents", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const layer = organizer("read-only", writes);
    for (const name of ["update_agent", "delete_agent"] as const) {
      const result = yield* run(layer, name, { id: filed.id });
      expect(result).toMatchObject({ code: "capability_denied" });
    }
    expect(writes).toEqual([]);
  }),
);
