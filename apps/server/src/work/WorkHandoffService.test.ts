import { expect, it } from "@effect/vitest";
import {
  AgentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type Project,
  TextGenerationError,
  OrchestrationV2DomainEventJson,
  OrchestrationV2AppThreadJson,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ids from "@t3tools/provider-core/server/IdAllocator";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Work from "./WorkHandoffService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Clones from "../project/ProjectCloneTracker.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as Settings from "../serverSettings.ts";
import * as SqlClient from "effect/sql/SqlClient";
import WorkMetadataMigration from "../persistence/Migrations/066_WorkThreadMetadata.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const encodeThreadJson = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));

const sourceId = ThreadId.make("chat:source");
const targetId = ProjectId.make("repo:target");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const repo: Project = {
  id: targetId,
  title: "booking-audit",
  workspaceRoot: "/workspace/booking-audit",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const create = (
  threadId: ThreadId,
): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId: ProjectId.make("chat:project"),
  title: "Audit design",
  modelSelection: selection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
});
const input = {
  commandId: CommandId.make("handoff:one"),
  sourceThreadId: sourceId,
  targetProjectId: targetId,
  title: "Fix audit",
  scopeSummary: "Implement booking-audit validation with focused tests.",
};
const database = Sqlite.layerMemory;
const layerRegistry = Layer.mock(Registry.ProviderAdapterRegistryV2)({
  list: () => Effect.succeed([selection.instanceId]),
  getMetadata: () =>
    Effect.succeed({
      driver: ProviderDriverKind.make("codex"),
      continuationKey: "codex",
      enabled: true,
      capabilities: CodexProviderCapabilitiesV2,
    }),
  // No provider CLI is spawned by these integration tests.
  get: (instanceId) =>
    Effect.succeed(
      ProviderAdapter.ProviderAdapterV2.of({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.die("No selection transition in this test"),
        openSession: (request) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ProviderDriverKind.make("codex"),
              providerSessionId: request.providerSessionId,
              cause: "Provider unavailable in test",
            }),
          ),
      }),
    ),
});
const runtime = Layer.mergeAll(
  database,
  layerWithRegistry({ name: "work-handoff" }, layerRegistry, {
    databaseLayer: database,
    runEffectWorker: false,
  }),
  Events.layer.pipe(Layer.provide(database)),
  Receipts.layer.pipe(Layer.provide(database)),
);

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const finished = yield* Deferred.make<void>();
  const worktrees: string[] = [];
  const boundaries = Layer.mergeAll(
    Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
    Layer.mock(Threads.ThreadManagementService)({
      dispatch: (command) => orchestrator.dispatch(command),
      getThreadRecords: orchestrator.getThreadRecords,
      getThreadProjection: orchestrator.getThreadProjection,
      getThreadSnapshotWindow: orchestrator.getThreadSnapshotWindow,
      getThreadShell: orchestrator.getThreadShell,
      getThreadEventSequence: orchestrator.getThreadEventSequence,
      streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
      assertProviderInstanceEnabled: () => Effect.void,
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) => Effect.succeed(id === targetId ? Option.some(repo) : Option.none()),
      listShells: () => Effect.succeed([{ ...repo, repositoryIdentity: null }]),
    }),
    Layer.mock(Git.GitWorkflowService)({
      hasCommit: () => Effect.succeed(false),
      createWorktree: (request) =>
        Effect.sync(() => {
          worktrees.push(request.cwd);
          return {
            worktree: {
              path: "/workspace/isolated-audit",
              refName: request.newRefName!,
              isDefault: false,
              isDetached: false,
            },
          };
        }),
      renameBranch: (request) => Effect.succeed({ branch: request.newBranch }),
    }),
    Layer.mock(Tracker.WorktreeSetupTracker)({
      begin: () => Effect.void,
      update: () => Effect.void,
      stage: () => Effect.void,
      stageStatus: () => Effect.void,
      markUncancellable: () => Effect.void,
      finish: (_id, status) =>
        status === "done"
          ? Deferred.succeed(finished, undefined).pipe(Effect.as(null))
          : Deferred.die(finished, `Preparation ${status}`).pipe(Effect.as(null)),
    }),
    Layer.mock(Clones.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Setup.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" }),
    }),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
    Layer.mock(Terminals.TerminalManager)({}),
    Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(Text.TextGeneration)({
      generateBranchName: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generateBranchName", detail: "Disabled in test" }),
        ),
      generateThreadTitle: () => Effect.succeed({ title: "Implement audit validation" }),
    }),
    Settings.layerTest(),
    Ids.layer,
  );
  const launches = Launch.layer.pipe(Layer.provide(boundaries));
  const work = Work.layer.pipe(Layer.provide(Layer.merge(launches, boundaries)));
  return { orchestrator, finished, worktrees, work };
});

it.effect(
  "hands chat scope to a worktree in the chosen repo, records both links and retries once",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.orchestrator.dispatch(create(sourceId));
      yield* Effect.gen(function* () {
        const service = yield* Work.WorkHandoffService;
        const result = yield* service.start(input);
        yield* Deferred.await(h.finished);
        const projection = yield* h.orchestrator.getThreadProjection(result.threadId);
        expect(projection.thread.projectId).toBe(targetId);
        expect(projection.thread.worktreePath).toBe("/workspace/isolated-audit");
        expect(projection.thread.branch).toBeTruthy();
        expect(projection.thread.workOrigin).toBe("chat");
        expect(projection.thread.sourceThreadId).toBe(sourceId);
        expect(projection.runs[0]?.workspacePreparation?.type).toBe("worktree");
        expect(projection.messages[0]?.text).toContain(input.scopeSummary);
        expect(projection.messages[0]?.text).toContain(`t3-thread://v1/${sourceId}`);
        expect(projection.contextHandoffs[0]?.sourceThreadId).toBe(sourceId);
        expect(projection.contextHandoffs[0]?.summaryText).toBe(input.scopeSummary);
        expect(
          (yield* h.orchestrator.getThreadProjection(sourceId)).thread.workHandoffs?.[0]?.threadId,
        ).toBe(result.threadId);
        expect((yield* service.start(input)).threadId).toBe(result.threadId);
        expect(h.worktrees).toEqual([repo.workspaceRoot]);
        expect(
          (yield* h.orchestrator.getThreadProjection(sourceId)).thread.workHandoffs,
        ).toHaveLength(1);
        // Follow-up effects commit after commands. Drain even though the provider
        // boundary is deliberately unavailable and will record a real failure.
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
        const events = yield* Events.EventStoreV2;
        const stored = yield* Stream.runCollect(events.read({ threadId: result.threadId }));
        const replay = yield* Effect.gen(function* () {
          const store = yield* Projections.ProjectionStoreV2;
          for (const entry of stored) yield* store.apply(entry.event);
          return yield* store.getThreadProjection(result.threadId);
        }).pipe(Effect.provide(Projections.layerMemory));
        expect(replay.thread.workOrigin).toBe("chat");
        expect(replay.thread.sourceThreadId).toBe(sourceId);
        expect(replay.contextHandoffs[0]?.summaryText).toBe(input.scopeSummary);
      }).pipe(Effect.provide(h.work));
    }).pipe(Effect.provide(runtime)),
);

it.effect("proposes a bounded editable draft without launching", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.orchestrator.dispatch(create(sourceId));
    yield* Effect.gen(function* () {
      const service = yield* Work.WorkHandoffService;
      const draft = yield* service.proposeHandoff(sourceId);
      expect(draft.title).toBe("Audit design");
      expect(draft.scopeSummary).toContain("Confirm the implementation scope");
      expect(draft.suggestedProjectId).toBe(null);
      expect(h.worktrees).toEqual([]);
    }).pipe(Effect.provide(h.work));
  }).pipe(Effect.provide(runtime)),
);

it.effect(
  "defaults legacy thread metadata on projection replay and preserves explicit agent provenance",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const agentId = AgentId.make("agent:engineering");
      yield* h.orchestrator.dispatch({
        ...create(sourceId),
        agent: { id: agentId, role: "work" },
        sourceAgentRunId: "agent-run:one",
      });
      const thread = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
      expect(thread.workOrigin).toBe("agent");
      expect(thread.sourceAgentId).toBe(agentId);
      expect(thread.sourceAgentRunId).toBe("agent-run:one");
      const {
        workOrigin: _origin,
        sourceAgentId: _agent,
        sourceAgentRunId: _run,
        ...legacy
      } = thread;
      const event: OrchestrationV2DomainEvent = {
        id: EventId.make("legacy"),
        type: "thread.created",
        threadId: sourceId,
        occurredAt: thread.createdAt,
        payload: legacy,
      };
      const codec = Schema.fromJsonString(OrchestrationV2DomainEventJson);
      const encoded = yield* Schema.encodeEffect(codec)(event);
      const decoded = yield* Schema.decodeEffect(codec)(encoded);
      expect(
        Projections.emptyProjection(
          decoded as Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>,
        ).thread.workOrigin,
      ).toBe("agent");
      expect(
        Projections.emptyProjection({ ...event, payload: { ...legacy, agent: undefined } }).thread
          .workOrigin,
      ).toBe("direct");
      const snapshot = yield* h.orchestrator.getShellSnapshot();
      expect(
        snapshot.threads.find((candidate) => candidate.id === sourceId)?.sourceAgentRunId,
      ).toBe("agent-run:one");
    }).pipe(Effect.provide(runtime)),
);

it.effect(
  "suggests a mentioned repo and generates a title through the existing cheap text path",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.orchestrator.dispatch(create(sourceId));
      yield* h.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("chat:discuss"),
        messageId: MessageId.make("chat:discuss"),
        threadId: sourceId,
        text: "Please fix validation in booking-audit. Preserve existing URL handling.",
        attachments: [],
        modelSelection: selection,
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* Effect.gen(function* () {
        const service = yield* Work.WorkHandoffService;
        const draft = yield* service.proposeHandoff(sourceId);
        expect(draft.title).toBe("Implement audit validation");
        expect(draft.scopeSummary).toContain("Preserve existing URL handling.");
        expect(draft.suggestedProjectId).toBe(targetId);
        expect(h.worktrees).toEqual([]);
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      }).pipe(Effect.provide(h.work));
    }).pipe(Effect.provide(runtime)),
);

it.effect("records agent-initiated Work with the same launch and handoff paths", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.orchestrator.dispatch(create(sourceId));
    yield* Effect.gen(function* () {
      const service = yield* Work.WorkHandoffService;
      const result = yield* service.start(input, {
        origin: "agent",
        sourceAgentId: AgentId.make("agent:owner"),
        sourceAgentRunId: "agent:trigger-run",
      });
      yield* Deferred.await(h.finished);
      const projection = yield* h.orchestrator.getThreadProjection(result.threadId);
      expect(projection.thread.workOrigin).toBe("agent");
      expect(projection.thread.sourceAgentId).toBe("agent:owner");
      expect(projection.thread.sourceAgentRunId).toBe("agent:trigger-run");
      const shell = (yield* h.orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === result.threadId,
      );
      expect(shell?.agent?.role).toBe("work");
      expect(shell?.workOrigin).toBe("agent");
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
    }).pipe(Effect.provide(h.work));
  }).pipe(Effect.provide(runtime)),
);

it.effect("honors an explicit local workspace choice", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.orchestrator.dispatch(create(sourceId));
    yield* Effect.gen(function* () {
      const service = yield* Work.WorkHandoffService;
      const result = yield* service.start({ ...input, workspace: "local" });
      yield* Deferred.await(h.finished);
      const projection = yield* h.orchestrator.getThreadProjection(result.threadId);
      expect(projection.thread.projectId).toBe(targetId);
      expect(projection.thread.worktreePath).toBe(null);
      expect(projection.runs[0]?.workspacePreparation?.type).toBe("root");
      expect(h.worktrees).toEqual([]);
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
    }).pipe(Effect.provide(h.work));
  }).pipe(Effect.provide(runtime)),
);

it.effect("backfills old agent run provenance idempotently without rewriting the event log", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const agentId = AgentId.make("agent:legacy");
    yield* h.orchestrator.dispatch({ ...create(sourceId), agent: { id: agentId, role: "work" } });
    const sql = yield* SqlClient.SqlClient;
    const thread = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
    const {
      workOrigin: _origin,
      sourceAgentId: _agent,
      sourceAgentRunId: _run,
      ...legacy
    } = thread;
    const payload = yield* encodeThreadJson(legacy);
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload} WHERE thread_id = ${sourceId}`;
    yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES (${agentId}, 'legacy:conversation', '{}', 1)`;
    yield* sql`INSERT INTO agent_work_runs(run_id, agent_id, trigger_id, work_thread_id, status, created_at) VALUES ('legacy:run', ${agentId}, 'legacy:trigger', ${sourceId}, 'completed', '2026-01-01T00:00:00.000Z')`;
    yield* WorkMetadataMigration;
    yield* WorkMetadataMigration;
    const migrated = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
    expect(migrated.workOrigin).toBe("agent");
    expect(migrated.sourceAgentId).toBe(agentId);
    expect(migrated.sourceAgentRunId).toBe("legacy:run");
    const events = yield* Events.EventStoreV2;
    const stored = yield* Stream.runCollect(events.read({ threadId: sourceId }));
    expect(stored).toHaveLength(1);
  }).pipe(Effect.provide(runtime)),
);
