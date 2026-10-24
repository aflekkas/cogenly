import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BUILDER_THREAD_TITLE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  defaultAgentPermissions,
  type AgentApprovalAction,
  type AgentBuilderProposal,
  type AgentId,
  type AgentUpsertInput,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import * as LabelEvents from "../persistence/OrchestrationEventStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Store from "./AgentStore.ts";
import * as Agents from "./AgentService.ts";
import * as Policy from "./AgentMcpPolicy.ts";
import * as Workspace from "./AgentWorkspaceService.ts";
import * as WorkspaceMcp from "./WorkspaceMcp.ts";
import { agentKickoffText, builderSystemPrompt } from "./builderPrompt.ts";
import { agentFixture } from "./agent.testkit.ts";

const scratchProjectId = ProjectId.make("project:scratch");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const proposal = (overrides: Partial<AgentBuilderProposal> = {}): AgentBuilderProposal => ({
  name: "PR Digest",
  face: { shape: "nuage", color: "bleu", expression: "attentif" },
  responsibility: "Watch my open pull requests and send me a morning summary.",
  triggers: [],
  needs: [],
  permissions: {},
  ...overrides,
});

const makeHarness = Effect.sync(() => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const launches: Launch.ThreadLaunchInput[] = [];
  const sends: Threads.ThreadManagementSendInput[] = [];
  const posts: Parameters<Events.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
  const runFor = (threadId: ThreadId): OrchestrationV2Run => ({
    id: RunId.make(`run:${threadId}`),
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });
  const seedThread = (threadId: ThreadId, surface?: "chat" | "work" | "builder") => {
    const projection = idleThreadProjection({
      ...liveThreadShell(threadId),
      ...(surface === undefined ? {} : { surface }),
    });
    projections.set(threadId, projection);
    return projection;
  };
  const boundaries = Layer.mergeAll(
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: Effect.succeed("/unused"),
      scratchRoot: Effect.succeed(Option.none()),
      ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const threadId = input.threadId!;
          const projection = idleThreadProjection({
            ...liveThreadShell(threadId),
            ...(input.surface === undefined ? {} : { surface: input.surface }),
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.title === undefined ? {} : { title: input.title }),
          });
          projections.set(threadId, projection);
          return { threadId, projection, resumed: false };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(projections.has(id) ? liveThreadShell(id) : null),
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          const run = runFor(input.threadId);
          return {
            dispatch: { sequence: 0, storedEvents: [] },
            projection: projections.get(input.threadId)!,
            message: {
              id: input.messageId,
              threadId: input.threadId,
              runId: run.id,
              nodeId: null,
              role: "user" as const,
              text: input.text,
              attachments: [],
              streaming: false,
              createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
              updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            },
            run,
            turnItem: null,
            delivery: "queued" as const,
          };
        }),
      dispatch: () => Effect.succeed({ sequence: 0, storedEvents: [] }),
    }),
    Layer.mock(Projections.ProjectionStoreV2)({
      getThreadRecords: (id) => {
        const projection = projections.get(id);
        return projection
          ? Effect.succeed(projection)
          : Effect.fail(new Projections.ProjectionStoreThreadNotFoundError({ threadId: id }));
      },
      getThread: (id) => Effect.succeed(projections.get(id)!.thread),
      getThreadShell: (id) =>
        Effect.succeed(
          projections.has(id) ? { ...liveThreadShell(id), ...projections.get(id)!.thread } : null,
        ),
    }),
    Layer.mock(Events.EventSinkV2)({
      commitCommand: (input) =>
        Effect.succeed({
          receipt: {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            status: "accepted" as const,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            error: null,
          },
          storedEvents: [],
          committed: true,
          cancelledEffectCount: 0,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              posts.push(input);
            }),
          ),
        ),
    }),
    Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(_name: string, _work: Effect.Effect<void, E, R>) => Effect.void,
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-builder-" }),
  );
  const database = Sqlite.layerMemory;
  const store = Store.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(Layer.provide(database));
  const labels = Labels.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(Layer.provide(Layer.merge(database, LabelEvents.layer.pipe(Layer.provide(database)))));
  const agents = Agents.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(Layer.provide(Layer.mergeAll(boundaries, store, labels, database)));
  const layer = Layer.mergeAll(store, agents, labels, database, boundaries).pipe(
    Layer.provide(NodeServices.layer),
  );
  return { launches, sends, posts, projections, seedThread, runFor, layer };
});

const createInput = (overrides: Partial<AgentUpsertInput> = {}): AgentUpsertInput => ({
  name: "Juniper",
  avatar: { seed: "one", color: "bleu" },
  instructions: "Be brief.",
  modelSelection,
  runtimeMode: "full-access",
  projectId: ProjectId.make("project:one"),
  dailyRunCap: 2,
  responsibility: "Keep commitments current.",
  ...overrides,
});

describe("builderStart", () => {
  it.effect("launches a builder-surface thread with the owner's first words", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const result = yield* agents.builderStart({
          projectId: ProjectId.make("project:one"),
          modelSelection,
          text: "Watch my PRs for me",
        });
        expect(result.threadId.startsWith("agent-builder:")).toBe(true);
        expect(result.projectId).toBe("project:one");
        expect(h.launches).toHaveLength(1);
        expect(h.launches[0]).toMatchObject({
          surface: "builder",
          threadId: result.threadId,
          projectId: ProjectId.make("project:one"),
          title: BUILDER_THREAD_TITLE,
          modelSelection,
          createdBy: "user",
          initialMessage: { text: "Watch my PRs for me", attachments: [] },
        });
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("falls back to Scratch without a project", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const result = yield* agents.builderStart({ modelSelection, text: "Help me plan" });
        expect(result.projectId).toBe(scratchProjectId);
        expect(h.launches[0]?.projectId).toBe(scratchProjectId);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("refuses a project folder that no longer exists before launching", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const failure = yield* agents
          .builderStart({
            modelSelection,
            text: "Help me plan",
            projectFolderId: ProjectLabelId.make("label:gone"),
          })
          .pipe(Effect.flip);
        expect(failure.message).toBe("That project no longer exists.");
        expect(h.launches).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

describe("builder turn context", () => {
  const insertThread = (threadId: string, surface: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, 'project:scratch', 'New agent', 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${JSON.stringify({ surface })})`;
    });

  it.effect("briefs builder threads with the builder prompt, and nothing else", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const builder = ThreadId.make("agent-builder:test");
        const chat = ThreadId.make("thread:chat");
        yield* insertThread(builder, "builder");
        yield* insertThread(chat, "chat");
        expect(yield* store.context(builder)).toBe(builderSystemPrompt);
        expect(yield* store.context(builder)).not.toContain("=== What I want ===");
        expect(yield* store.context(chat)).not.toContain("propose_agent");
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

describe("recordProposal", () => {
  it.effect("emits one proposal item per thread; later calls replace earlier ones", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const threadId = ThreadId.make("agent-builder:test");
        h.seedThread(threadId, "builder");
        const first = proposal();
        const second = proposal({ name: "Second Draft" });
        yield* agents.recordProposal({ threadId, proposal: first });
        yield* agents.recordProposal({ threadId, proposal: second });
        expect(h.posts).toHaveLength(2);
        const [one, two] = h.posts;
        expect(one?.commandType).toBe("agent.propose");
        expect(one?.commandId).not.toBe(two?.commandId);
        for (const post of [one, two]) {
          expect(post?.events).toHaveLength(1);
          expect(post?.events[0]?.type).toBe("turn-item.updated");
        }
        const firstPayload = one?.events[0];
        const secondPayload = two?.events[0];
        expect(firstPayload).toMatchObject({
          type: "turn-item.updated",
          payload: { type: "agent_proposal", id: `agent-proposal:${threadId}`, proposal: first },
        });
        expect(secondPayload).toMatchObject({
          type: "turn-item.updated",
          payload: {
            type: "agent_proposal",
            id: `agent-proposal:${threadId}`,
            proposal: second,
          },
        });
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("refuses threads that are not builders", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const chat = ThreadId.make("thread:chat");
        h.seedThread(chat, "chat");
        const result = yield* Effect.result(
          agents.recordProposal({ threadId: chat, proposal: proposal() }),
        );
        expect(result._tag).toBe("Failure");
        expect(h.posts).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

describe("kickoff", () => {
  it.effect("opens a create with the agent's own turn, never an owner message", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const { agent } = yield* agents.upsert(createInput({ kickoff: true }));
        expect(h.sends).toHaveLength(1);
        expect(h.sends[0]).toMatchObject({
          threadId: agent.conversationThreadId,
          text: agentKickoffText,
          createdBy: "agent",
          creationSource: "server",
          modelSelection: agent.modelSelection,
        });
        expect(h.sends.filter((send) => send.createdBy === "user")).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("stays quiet without kickoff, and on edits", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const { agent } = yield* agents.upsert(createInput());
        expect(h.sends).toHaveLength(0);
        yield* agents.upsert({ ...createInput(), id: agent.id, kickoff: true, name: "Pine" });
        expect(h.sends).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

describe("propose_agent policy", () => {
  const makePolicyHarness = Effect.sync(() => {
    const shells = new Map<ThreadId, "builder" | "chat">();
    const database = Sqlite.layerMemory;
    const store = Store.layer
      .pipe(Layer.provide(layerSharedIdentity))
      .pipe(Layer.provide(database));
    const layer = Layer.mergeAll(
      Policy.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            store,
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: (id) => {
                const surface = shells.get(id);
                return Effect.succeed(
                  surface === undefined ? null : { ...liveThreadShell(id), surface },
                );
              },
            }),
            Layer.mock(Workspace.AgentWorkspaceService)({}),
            Layer.mock(Settings.ServerSettingsService)({}),
            Layer.mock(TextGeneration.TextGeneration)({}),
            database,
          ),
        ),
      ),
      store,
      database,
    ).pipe(Layer.provide(NodeServices.layer));
    return { shells, layer };
  });

  it.effect("lets builder threads propose, and stops every other caller", () =>
    Effect.gen(function* () {
      const h = yield* makePolicyHarness;
      yield* Effect.gen(function* () {
        const policy = yield* Policy.AgentMcpPolicy;
        const builder = ThreadId.make("agent-builder:test");
        const chat = ThreadId.make("thread:chat");
        h.shells.set(builder, "builder");
        h.shells.set(chat, "chat");
        expect(yield* policy.beforeTool(scopeFor(builder), "propose_agent", {}, false)).toEqual({
          handled: false,
        });
        const chatResult = yield* Effect.result(
          policy.beforeTool(scopeFor(chat), "propose_agent", {}, false),
        );
        expect(chatResult._tag).toBe("Failure");
        const missingResult = yield* Effect.result(
          policy.beforeTool(
            { ...scopeFor(builder), thread: undefined },
            "propose_agent",
            {},
            false,
          ),
        );
        expect(missingResult._tag).toBe("Failure");
        const goneResult = yield* Effect.result(
          policy.beforeTool(scopeFor(ThreadId.make("thread:gone")), "propose_agent", {}, false),
        );
        expect(goneResult._tag).toBe("Failure");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("passes trigger proposals through, and gates profile edits on execute", () =>
    Effect.gen(function* () {
      const h = yield* makePolicyHarness;
      yield* Effect.gen(function* () {
        const policy = yield* Policy.AgentMcpPolicy;
        const store = yield* Store.AgentStore;
        const agent = yield* store.save(agentFixture());
        h.shells.set(agent.conversationThreadId, "chat");
        const scope = scopeFor(agent.conversationThreadId);
        expect(yield* policy.beforeTool(scope, "propose_trigger", {}, false)).toEqual({
          handled: false,
        });
        expect(yield* policy.beforeTool(scope, "propose_event_trigger", {}, false)).toEqual({
          handled: false,
        });
        expect(
          yield* policy.beforeTool(scope, "update_own_profile", { name: "Pine" }, false),
        ).toEqual({ handled: false });
        yield* store.save({
          ...agent,
          permissions: { ...defaultAgentPermissions, execute: false },
        });
        const denied = yield* Effect.result(
          policy.beforeTool(scope, "update_own_profile", { name: "Pine" }, false),
        );
        expect(denied._tag).toBe("Failure");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("lets agents list agents but never start builders", () =>
    Effect.gen(function* () {
      const h = yield* makePolicyHarness;
      yield* Effect.gen(function* () {
        const policy = yield* Policy.AgentMcpPolicy;
        const store = yield* Store.AgentStore;
        const agent = yield* store.save(agentFixture());
        h.shells.set(agent.conversationThreadId, "chat");
        const scope = scopeFor(agent.conversationThreadId);
        expect(yield* policy.beforeTool(scope, "list_agents", {}, true)).toEqual({
          handled: false,
        });
        const denied = yield* Effect.result(
          policy.beforeTool(scope, "start_agent_builder", { text: "Another me" }, false),
        );
        expect(denied._tag).toBe("Failure");
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

describe("agent thread tools", () => {
  const agent = agentFixture("tools");
  const requests: { agentId: AgentId; action: AgentApprovalAction }[] = [];
  const upserts: AgentUpsertInput[] = [];
  const serverLayer = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(WorkspaceMcp.toolkit, WorkspaceMcp.handlers),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(id === agent.conversationThreadId ? liveThreadShell(id) : null),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(Store.AgentStore)({
        forThread: (id) => Effect.succeed(id === agent.conversationThreadId ? agent : null),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(Workspace.AgentWorkspaceService)({
        requestApproval: (agentId, action) =>
          Effect.sync(() => {
            requests.push({ agentId, action });
            return {
              approval: {
                id: `approval:${requests.length}`,
                agentId,
                action,
                actionKind: action.actionKind,
                payload: {},
                status: "pending" as const,
                requestedAt: "2026-01-01T00:00:00.000Z",
                decidedAt: null,
                decidedBy: null,
                sourceRunId: null,
                resultThreadId: null,
              },
            };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(Agents.AgentService)({
        upsert: (input) =>
          Effect.sync(() => {
            upserts.push(input);
            return { agent };
          }),
      }),
    ),
  );

  const threadScope = (threadId: ThreadId): Invocation.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: `provider:${threadId}`,
    thread: {
      threadId,
      providerSessionId: `provider:${threadId}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });
  const mcpClient = McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "builder-test", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "builder-test", version: "1" },
    },
    getClient: Effect.die("unused"),
  });
  const call = (tool: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
      Effect.provideService(
        Invocation.McpInvocationContext,
        threadScope(agent.conversationThreadId),
      ),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(serverLayer),
    );

  it.effect("proposes every schedule kind through the owner-approval path", () =>
    Effect.gen(function* () {
      const schedules = [
        { type: "interval", everyMs: 3_600_000 },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
        { type: "event", event: "pr.updated" },
        { type: "webhook" },
      ] as const;
      for (const [index, schedule] of schedules.entries()) {
        requests.length = 0;
        const result = yield* call("propose_trigger", {
          title: `Trigger ${index}`,
          prompt: "Do the thing.",
          schedule,
        });
        expect(result.isError).toBe(false);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.agentId).toBe(agent.id);
        expect(requests[0]?.action).toMatchObject({
          actionKind: "schedule_trigger",
          payload: { schedule, enabled: true, agentId: agent.id },
        });
      }
    }),
  );

  it.effect("keeps propose_event_trigger as a working alias", () =>
    Effect.gen(function* () {
      requests.length = 0;
      const result = yield* call("propose_event_trigger", {
        title: "On PR updates",
        prompt: "Review the diff.",
        schedule: { type: "event", event: "pr.updated" },
      });
      expect(result.isError).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.action).toMatchObject({
        actionKind: "schedule_trigger",
        payload: { schedule: { type: "event", event: "pr.updated" } },
      });
    }),
  );

  it.effect("lets an agent update its own profile", () =>
    Effect.gen(function* () {
      upserts.length = 0;
      const result = yield* call("update_own_profile", {
        name: "Pine",
        avatar: { color: "vert" },
        responsibility: "Keep the garden.",
      });
      expect(result.isError).toBe(false);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        id: agent.id,
        name: "Pine",
        avatar: { seed: agent.avatar.seed, color: "vert" },
        responsibility: "Keep the garden.",
        instructions: agent.instructions,
      });
    }),
  );

  it.effect("rejects a profile edit from a thread that is no agent's", () =>
    Effect.gen(function* () {
      const stranger = McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({
            name: "update_own_profile",
            arguments: { name: "Mallory" },
          }),
        ),
        Effect.provideService(
          Invocation.McpInvocationContext,
          threadScope(ThreadId.make("thread:stranger")),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.provide(serverLayer),
      );
      const result = yield* stranger;
      expect(result.isError).toBe(true);
    }),
  );
});
