import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ProviderDriverKind } from "@cogenly/contracts";
import { ProjectRepositoryMismatchError } from "@cogenly/contracts";
import * as SharedState from "../sync/SharedState.ts";
import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as Option from "effect/Option";
import * as AgentEvents from "./AgentEventBus.ts";
import * as EventReactor from "./AgentEventReactor.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Work from "../work/WorkHandoffService.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import * as LabelEvents from "../persistence/OrchestrationEventStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Settings from "../serverSettings.ts";
import * as Workspace from "./AgentWorkspaceService.ts";
import * as Policy from "./AgentMcpPolicy.ts";
import { defaultAgentPermissions, EnvironmentId, ProviderInstanceId } from "@cogenly/contracts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  ProjectId,
  ProjectLabelId,
  CheckpointId,
  CheckpointScopeId,
  CheckpointRef,
  NodeId,
  type AgentEventContext,
  type OrchestrationV2StoredEvent,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ScheduledTaskUpsertInput,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as Agents from "./AgentService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { migrateLegacyAgents } from "../persistence/Migrations/063_Agents.ts";
import { agentFixture } from "./agent.testkit.ts";

const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeHarness = Effect.sync(() => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const launches: Launch.ThreadLaunchInput[] = [];
  const launchFailure: { current: ProjectRepositoryMismatchError | null } = { current: null };
  const posts: Parameters<Events.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
  const jobs = new Map<string, Effect.Effect<void>>();
  const receipts = new Set<string>();
  const fixture = agentFixture();
  const conversation = idleThreadProjection(liveThreadShell(fixture.conversationThreadId));
  projections.set(fixture.conversationThreadId, conversation);
  const calls: Threads.ThreadManagementSendInput[] = [];
  const commands: import("@cogenly/contracts").OrchestrationV2ServerCommand[] = [];
  const runFor = (
    threadId: ThreadId,
    status: OrchestrationV2Run["status"] = "completed",
  ): OrchestrationV2Run => ({
    id: RunId.make(`run:${threadId}`),
    threadId,
    ordinal: 1,
    providerInstanceId: fixture.modelSelection.instanceId,
    modelSelection: fixture.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: DateTime.makeUnsafe(fixture.createdAt),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  });
  const boundaries = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        { instanceId: ProviderInstanceId.make("codex"), driver: ProviderDriverKind.make("codex") },
        {
          instanceId: ProviderInstanceId.make("codex-school"),
          driver: ProviderDriverKind.make("codex"),
        },
        {
          instanceId: ProviderInstanceId.make("claude-backup"),
          driver: ProviderDriverKind.make("claudeAgent"),
        },
      ] as import("@cogenly/contracts").ServerProvider[]),
    }),
    Layer.mock(Folders.ManagedProjectFolders)({
      namedProjectsRoot: Effect.succeed("/unused"),
      scratchRoot: Effect.succeed(Option.none()),
      ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("project:scratch") }),
    }),
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.suspend(() =>
          launchFailure.current === null ? Effect.void : Effect.fail(launchFailure.current),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              launches.push(input);
              const threadId = input.threadId!;
              let projection = idleThreadProjection(liveThreadShell(threadId));
              if (input.initialMessage) {
                const run = runFor(threadId);
                projection = {
                  ...projection,
                  runs: [run],
                  messages: [
                    {
                      id: MessageId.make(`response:${threadId}`),
                      threadId,
                      runId: run.id,
                      nodeId: null,
                      role: "assistant",
                      text: "Done. Your favourite colour is green.",
                      attachments: [],
                      streaming: false,
                      createdAt: DateTime.makeUnsafe(fixture.createdAt),
                      updatedAt: DateTime.makeUnsafe(fixture.createdAt),
                      createdBy: "agent",
                      creationSource: "provider",
                    },
                  ],
                };
              }
              projections.set(threadId, projection);
              return { threadId, projection, resumed: false };
            }),
          ),
        ),
    }),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.mock(Settings.ServerSettingsService)({}),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: (id) => Effect.succeed(projections.get(id)!),
      getThreadShell: (id) => Effect.succeed(projections.has(id) ? liveThreadShell(id) : null),
      sendToThread: (input) =>
        Effect.sync(() => {
          calls.push(input);
          const run = runFor(input.threadId, "running");
          return {
            dispatch: { sequence: 0, storedEvents: [] },
            projection: conversation,
            message: {
              id: input.messageId,
              threadId: input.threadId,
              runId: run.id,
              nodeId: null,
              role: "user" as const,
              text: input.text,
              attachments: input.attachments,
              streaming: false,
              createdAt: DateTime.makeUnsafe(fixture.createdAt),
              updatedAt: DateTime.makeUnsafe(fixture.createdAt),
              createdBy: "user" as const,
              creationSource: "web" as const,
            },
            run,
            turnItem: null,
            delivery: "queued" as const,
          };
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: 0, storedEvents: [] };
        }),
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
        Effect.sync(() => {
          if (!receipts.has(input.commandId)) {
            posts.push(input);
            receipts.add(input.commandId);
          }
          return {
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
          };
        }),
    }),
    Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          jobs.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    }),
    Layer.mock(Secrets.SecretRequests)({}),
    Layer.mock(Git.GitWorkflowService)({ isRepository: () => Effect.succeed(true) }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-service-" }),
  );
  const database = Sqlite.layerMemory;
  const store = Store.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(Layer.provide(database));
  const labels = Labels.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(
      Layer.provide(
        Layer.mergeAll(database, boundaries, LabelEvents.layer.pipe(Layer.provide(database))),
      ),
    );
  const agents = Agents.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(Layer.provide(Layer.mergeAll(boundaries, store, labels, database)));
  const schedules = Schedules.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(Layer.provide(Layer.mergeAll(boundaries, agents, store, database)));
  const work = Work.layer.pipe(Layer.provide(Layer.mergeAll(store, boundaries)));
  const workspace = Workspace.layer.pipe(
    Layer.provide(Layer.mergeAll(store, agents, schedules, work, boundaries, database)),
  );
  const policy = Policy.layer.pipe(
    Layer.provide(Layer.mergeAll(store, workspace, boundaries, database)),
  );
  const eventStore = EventStore.layerFromOrchestrationEventStore.pipe(
    Layer.provide(LabelEvents.layer.pipe(Layer.provide(database))),
  );
  const bus = AgentEvents.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(Layer.provide(Layer.mergeAll(agents, schedules, store, database)));
  const reactor = EventReactor.layer.pipe(
    Layer.provide(Layer.mergeAll(bus, eventStore, boundaries, database)),
  );
  const layer = Layer.mergeAll(
    store,
    agents,
    schedules,
    workspace,
    policy,
    labels,
    database,
    eventStore,
    bus,
    reactor,
    boundaries,
  ).pipe(Layer.provide(NodeServices.layer));
  const triggerInput: ScheduledTaskUpsertInput = {
    title: "Check colour",
    prompt: "Recall the owner's favourite colour.",
    agentId: fixture.id,
    enabled: true,
    schedule: { type: "interval", everyMs: 60000 },
    projectId: fixture.projectId!,
    threadId: fixture.conversationThreadId,
    workspaceStrategy: { type: "root" },
    modelSelection: fixture.modelSelection,
    runtimeMode: fixture.runtimeMode,
    interactionMode: "default",
  };
  return {
    layer,
    fixture,
    launches,
    launchFailure,
    posts,
    calls,
    commands,
    jobs,
    triggerInput,
    projections,
    runFor,
  };
});

describe("agent execution", () => {
  it.effect(
    "records a refused agent launch as a failed schedule and run with the membership error",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const schedules = yield* Schedules.ScheduledTaskService;
          yield* store.save(h.fixture);
          const { task } = yield* schedules.upsert(h.triggerInput);
          h.launchFailure.current = new ProjectRepositoryMismatchError({
            projectId: h.fixture.projectId!,
            projectFolderId: ProjectLabelId.make("label:spawn"),
            repositoryName: "cogenly",
            projectName: "Spawn Partners",
          });
          const result = yield* schedules.runNow({ id: task.id });
          expect(result.task.lastRunStatus).toBe("failed");
          expect(result.task.lastRunError).toBe(h.launchFailure.current.message);
          expect((yield* store.runs(h.fixture.id))[0]).toMatchObject({
            status: "failed",
            summary: h.launchFailure.current.message,
          });
        }).pipe(Effect.provide(h.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("refuses to save a new or edited agent with an unrelated project and repository", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const labels = yield* Labels.ProjectLabelService;
        const agents = yield* Agents.AgentService;
        const store = yield* Store.AgentStore;
        const folderId = (yield* labels.create({ name: "Spawn Partners" })).label.id;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${h.fixture.projectId},'cogenly','/repos/cogenly','[]',${h.fixture.createdAt},${h.fixture.createdAt})`;
        const input = { ...h.fixture, projectFolderId: folderId };
        const message =
          "cogenly is not in the Spawn Partners project. Add it to the project first, or start without a project.";
        const { id: _id, ...newInput } = input;
        expect((yield* Effect.flip(agents.upsert(newInput))).message).toBe(message);
        expect(h.launches).toEqual([]);
        yield* store.save(h.fixture);
        expect(
          (yield* Effect.flip(agents.upsert({ ...input, name: "Invalid edit" }))).message,
        ).toBe(message);
        expect((yield* store.get(h.fixture.id)).name).toBe(h.fixture.name);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("schedule command ids stay portable and idempotent for arbitrary request keys", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        yield* store.save(h.fixture);
        const schedules = yield* Schedules.ScheduledTaskService;
        for (const key of ["nightly%20digest", "nightly%3Adigest", "x".repeat(300)]) {
          const input = {
            ...h.triggerInput,
            commandId: CommandId.make(`command:mcp:session:schedule-task:${key}`),
          };
          const first = (yield* schedules.upsert(input)).task;
          expect(first.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/);
          expect((yield* schedules.upsert(input)).task.id).toBe(first.id);
        }
        const valid = CommandId.make("command:mcp:session:schedule-task:valid-key");
        expect((yield* schedules.upsert({ ...h.triggerInput, commandId: valid })).task.id).toBe(
          `scheduled-task:${valid}`,
        );
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.scoped),
  );
  it.effect.each(["starting", "running", "completed", "failed"] as const)(
    "restart recovery leaves another machine's %s run untouched",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const agents = yield* Agents.AgentService;
          yield* store.save({ ...h.fixture, ownerMachine: EnvironmentId.make("other-machine") });
          yield* store.createRun({
            id: "off-owner-run",
            agentId: h.fixture.id,
            triggerId: ScheduledTaskId.make("task:off-owner"),
            workThreadId: ThreadId.make("thread:off-owner"),
            status,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            completedAt: null,
            summary: null,
            posted: false,
          });
          const before = yield* store.runs(h.fixture.id);
          yield* agents.reconcile({ afterRestart: true });
          yield* agents.reconcile();
          expect(yield* store.runs(h.fixture.id)).toEqual(before);
          expect((yield* store.get(h.fixture.id)).consecutiveFailures).toBe(0);
          expect(h.posts).toEqual([]);
          expect(h.commands).toEqual([]);
          expect(h.calls).toEqual([]);
          expect(h.launches).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["starting", "running"] as const)(
    "startup fails an interrupted %s reservation and posts its reason once",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const agents = yield* Agents.AgentService;
          yield* store.save(h.fixture);
          yield* store.createRun({
            id: "interrupted-reservation",
            agentId: h.fixture.id,
            triggerId: ScheduledTaskId.make("task:interrupted"),
            workThreadId: ThreadId.make("thread:never-launched"),
            status,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            completedAt: null,
            summary: null,
            posted: false,
          });
          yield* agents.reconcile();
          expect((yield* store.runs(h.fixture.id))[0]?.status).toBe(status);
          expect(h.posts).toHaveLength(0);
          // No grace period: recovery runs before any scheduler can launch fresh work.
          yield* agents.reconcile({ afterRestart: true });
          yield* agents.reconcile({ afterRestart: true });
          const record = (yield* store.runs(h.fixture.id))[0]!;
          expect(record).toMatchObject({ status: "failed", posted: true });
          expect(record.completedAt).not.toBeNull();
          expect(record.summary).toContain("Cogenly restarted during this run");
          expect((yield* store.get(h.fixture.id)).consecutiveFailures).toBe(1);
          expect(h.posts).toHaveLength(1);
          expect(h.posts[0]?.effects).toEqual([]);
          expect(h.calls).toEqual([]);
          expect(h.launches).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("posts the restart failure instead of an interrupted job's partial answer", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert(h.triggerInput);
        yield* agents.trigger(task, "interrupted", task.prompt);
        const threadId = h.launches[0]!.threadId!;
        const projection = h.projections.get(threadId)!;
        const run = projection.runs[0]!;
        const at = yield* DateTime.now;
        h.projections.set(threadId, {
          ...projection,
          runs: [{ ...run, status: "failed", completedAt: at }],
          turnItems: [
            {
              id: TurnItemId.make("item:restart"),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Run interrupted",
              failure: {
                class: "transport_error",
                code: "server_restarted",
                message: "Cogenly restarted during this run.",
                retryable: true,
              },
              startedAt: at,
              completedAt: at,
              updatedAt: at,
            },
          ],
        });
        yield* agents.reconcile({ afterRestart: true });
        yield* agents.reconcile();
        const record = (yield* store.runs(h.fixture.id))[0]!;
        expect(record).toMatchObject({ status: "failed", posted: true });
        expect(record.summary).toContain("Cogenly restarted during this run");
        const posted = h.posts[0]?.events[0];
        expect(posted?.type === "message.updated" && posted.payload.text).toBe(record.summary);
        expect(h.posts).toHaveLength(1);
        expect((yield* store.get(h.fixture.id)).consecutiveFailures).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("an incoming agent tombstone stops owner work through the normal deletion path", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert(h.triggerInput);
        expect(yield* agents.trigger(task, "delete-running", task.prompt)).toBe(true);
        const context = yield* Layer.build(
          SharedState.layer.pipe(Layer.provide(layerSharedIdentity)),
        );
        const shared = yield* SharedState.SharedState.pipe(Effect.provideContext(context));
        const peer = EnvironmentId.make("editing-machine");
        yield* shared.receive(
          {
            after: 0,
            cursor: 1,
            changes: [
              {
                kind: "agent",
                id: h.fixture.id,
                fields: {},
                clocks: {},
                tombstone: { wall: 1, logical: 0, node: peer },
                updatedBy: peer,
              },
            ],
          },
          peer,
          false,
        );
        expect(
          (yield* sql<{
            enabled: number;
          }>`SELECT enabled FROM scheduled_tasks WHERE task_id=${task.id}`)[0]?.enabled,
        ).toBe(0);
        yield* agents.reconcile();
        expect(yield* store.list()).toHaveLength(0);
        expect((yield* schedules.list()).tasks).toHaveLength(0);
        expect(h.commands.filter((command) => command.type === "thread.stop")).toHaveLength(2);
        expect((yield* shared.get("schedule", task.id))?.tombstone).not.toBeNull();
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("only the owner fires agents, due schedules and event triggers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const ownerMachine = EnvironmentId.make("other-machine");
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert(h.triggerInput);
        // A replica arrives through sync; ordinary writes to a remote owner now route there.
        yield* store.save({ ...h.fixture, ownerMachine });
        yield* sql`UPDATE scheduled_tasks SET owner_machine=${ownerMachine}, next_run_at='1969-01-01T00:00:00.000Z' WHERE task_id=${task.id}`;
        expect(yield* store.reserve(h.fixture.id)).toBe(false);
        expect(yield* agents.trigger({ ...task, ownerMachine }, "off-owner", task.prompt)).toBe(
          false,
        );
        yield* h.jobs.get("scheduled-tasks")!;
        yield* agents.reconcile();
        expect(h.launches).toHaveLength(0);
        expect(yield* store.runs(h.fixture.id)).toHaveLength(0);
        expect((yield* schedules.list()).tasks[0]?.runCount).toBe(0);
        expect((yield* Effect.result(schedules.runNow({ id: task.id })))._tag).toBe("Failure");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "runs a trigger in a separate work thread and posts once without starting another turn",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const agents = yield* Agents.AgentService;
          const schedules = yield* Schedules.ScheduledTaskService;
          yield* store.save(h.fixture);
          yield* store.remember({ agentId: h.fixture.id, text: "Favourite colour: green" });
          const { task } = yield* schedules.upsert(h.triggerInput);
          yield* schedules.runNow({ id: task.id });
          expect(h.launches).toHaveLength(1);
          const work = h.launches[0]!;
          expect(work.threadId).not.toBe(h.fixture.conversationThreadId);
          expect(work.workOrigin).toBe("agent");
          expect(work.sourceAgentId).toBe(h.fixture.id);
          expect(work.sourceAgentRunId).toBe(work.threadId);
          expect(work.agent).toEqual({ id: h.fixture.id, role: "work" });
          expect(yield* store.context(work.threadId!)).toContain("green");
          expect(work.initialMessage?.text).toContain(h.triggerInput.prompt);
          yield* agents.reconcile();
          yield* agents.reconcile();
          expect(h.posts).toHaveLength(1);
          expect(h.posts[0]?.effects).toEqual([]);
          expect(h.posts[0]?.events[0]?.type).toBe("message.updated");
          const posted = h.posts[0]?.events[0];
          if (posted?.type === "message.updated") {
            expect(posted.payload.role).toBe("assistant");
            expect(posted.payload.senderThreadId).toBe(work.threadId);
            expect(posted.payload.text).toContain("green");
          }
          expect(h.launches).toHaveLength(1);
          expect(h.calls).toEqual([]);
          expect((yield* store.runs(h.fixture.id))[0]?.posted).toBe(true);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("catches up one missed fixed-time occurrence, then advances to the next slot", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const schedules = yield* Schedules.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert({
          ...h.triggerInput,
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
        });
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '1969-12-20T09:00:00.000Z' WHERE task_id = ${task.id}`;
        yield* h.jobs.get("scheduled-tasks")!;
        yield* h.jobs.get("scheduled-tasks")!;
        expect(h.launches).toHaveLength(1);
        expect((yield* schedules.list()).tasks[0]?.runCount).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("owner texts bypass failure backoff and the daily cap", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert(h.triggerInput);
        expect(yield* store.reserve(h.fixture.id)).toBe(true);
        expect(yield* store.reserve(h.fixture.id)).toBe(true);
        for (let failure = 0; failure < 5; failure++) yield* store.outcome(h.fixture.id, false);
        const backingOff = yield* store.get(h.fixture.id);
        expect(backingOff.backoffUntil).not.toBeNull();
        yield* agents.send({
          id: backingOff.id,
          commandId: CommandId.make("auto-paused:owner"),
          messageId: MessageId.make("auto-paused:owner"),
          text: "Hello",
        });
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]?.threadId).toBe(backingOff.conversationThreadId);
        expect(yield* agents.trigger(task, "backoff:trigger", task.prompt)).toBe(false);
        expect(h.launches).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("owner texts keep the conversation and queue behind active work", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        yield* store.save(h.fixture);
        const result = yield* agents.send({
          id: h.fixture.id,
          commandId: CommandId.make("send:one"),
          messageId: MessageId.make("send:one"),
          text: "Remember green",
          mode: "queue",
        });
        expect(result.threadId).toBe(h.fixture.conversationThreadId);
        expect(result.delivery).toBe("queued");
        expect(h.calls[0]?.mode).toBe("queue");
        expect(h.calls[0]?.text).toBe("Remember green");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("owner texts claim their uploads into the conversation, as a chat send does", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const config = yield* ServerConfig.ServerConfig;
        yield* store.save(h.fixture);
        const pendingId = ChatAttachmentId.make(createPendingAttachmentId());
        NodeFS.writeFileSync(
          NodePath.join(config.attachmentsDir, `${pendingId}.png`),
          new Uint8Array([1, 2, 3]),
        );
        yield* agents.send({
          id: h.fixture.id,
          commandId: CommandId.make("send:image"),
          messageId: MessageId.make("send:image"),
          text: "",
          attachments: [
            {
              type: "image",
              id: pendingId,
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          ],
        });
        const sent = h.calls[0]?.attachments[0];
        expect(h.calls[0]?.threadId).toBe(h.fixture.conversationThreadId);
        expect(sent?.id).not.toBe(pendingId);
        expect(
          NodeFS.readFileSync(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: sent! })!,
          ),
        ).toEqual(Buffer.from([1, 2, 3]));
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("a missing upload fails the text before it reaches the conversation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        yield* store.save(h.fixture);
        const error = yield* agents
          .send({
            id: h.fixture.id,
            commandId: CommandId.make("send:missing"),
            messageId: MessageId.make("send:missing"),
            text: "Look",
            attachments: [
              {
                type: "image",
                id: ChatAttachmentId.make(createPendingAttachmentId()),
                name: "gone.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ],
          })
          .pipe(Effect.flip);
        expect(error.message).toContain("gone.png");
        expect(h.calls).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});

it.effect("legacy migration is idempotent and combines triggers bound to one conversation", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const schedules = yield* Schedules.ScheduledTaskService;
      const store = yield* Store.AgentStore;
      const sql = yield* SqlClient.SqlClient;
      const { agentId: _agentId, ...legacy } = h.triggerInput;
      const first = yield* schedules.upsert({ ...legacy, enabled: false });
      const second = yield* schedules.upsert({ ...legacy, title: "Another trigger" });
      yield* migrateLegacyAgents;
      yield* migrateLegacyAgents;
      expect(yield* store.list()).toHaveLength(1);
      const agents = yield* store.list();
      expect(agents[0]?.conversationThreadId).toBe(legacy.threadId);
      const rows = yield* sql<{
        agent_id: string;
      }>`SELECT agent_id FROM scheduled_tasks WHERE task_id IN (${first.task.id}, ${second.task.id})`;
      expect(new Set(rows.map((r) => r.agent_id)).size).toBe(1);
      expect(rows[0]?.agent_id).toBe(agents[0]?.id);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("keeps running jobs after repeated provider failures once each backoff elapses", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agents = yield* Agents.AgentService;
      const schedules = yield* Schedules.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* store.save({ ...h.fixture, dailyRunCap: 100 });
      const { task } = yield* schedules.upsert(h.triggerInput);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* sql`UPDATE agents SET backoff_until = NULL WHERE agent_id = ${h.fixture.id}`;
        const started = yield* agents.trigger(task, `failure:${attempt}`, task.prompt);
        expect(started).toBe(true);
        const launch = h.launches.at(-1)!;
        const projection = h.projections.get(launch.threadId!)!;
        h.projections.set(launch.threadId!, {
          ...projection,
          runs: projection.runs.map((run) => ({ ...run, status: "failed" })),
          messages: [],
        });
        yield* agents.reconcile();
      }
      expect((yield* store.get(h.fixture.id)).consecutiveFailures).toBe(5);
      expect(yield* agents.trigger(task, "during-backoff", task.prompt)).toBe(false);
      yield* sql`UPDATE agents SET backoff_until = NULL WHERE agent_id = ${h.fixture.id}`;
      expect(yield* agents.trigger(task, "after-backoff", task.prompt)).toBe(true);
      expect(h.launches).toHaveLength(6);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect(
  "a usage-limited run skips a same-provider account and uses its cross-provider fallback",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const fallback = { instanceId: ProviderInstanceId.make("claude-backup"), model: "opus" };
        yield* store.save({
          ...h.fixture,
          dailyRunCap: 100,
          fallbackChain: [
            { instanceId: ProviderInstanceId.make("codex-school"), model: "gpt-5" },
            fallback,
          ],
        });
        const { task } = yield* schedules.upsert(h.triggerInput);
        expect(yield* agents.trigger(task, "fallback:first", task.prompt)).toBe(true);
        expect(h.launches.at(-1)?.modelSelection).toEqual(h.fixture.modelSelection);
        const first = h.launches.at(-1)!;
        const projection = h.projections.get(first.threadId!)!;
        const run = projection.runs[0]!;
        h.projections.set(first.threadId!, {
          ...projection,
          runs: [{ ...run, status: "failed" }],
          messages: [],
          turnItems: [
            {
              id: TurnItemId.make(`failure:${first.threadId}`),
              threadId: first.threadId!,
              runId: run.id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "failed",
              title: "Usage limit reached",
              startedAt: null,
              completedAt: null,
              updatedAt: DateTime.makeUnsafe(h.fixture.createdAt),
              type: "error",
              failure: {
                class: "usage_limit",
                message: "You've hit your weekly limit",
                code: "api_error_429",
                retryable: true,
                resetAt: "2099-01-01T00:00:00.000Z",
              },
            },
          ],
        });
        yield* agents.reconcile();
        const after = yield* store.get(h.fixture.id);
        expect(after.fallbackIndex).toBe(2);
        expect(after.fallbackChain).toHaveLength(2);
        expect(after.fallbackReason).toBe("usage_limit");
        expect(after.fallbackUntil).toBe("2099-01-01T00:00:00.000Z");
        const runs = yield* store.runs(h.fixture.id);
        expect(runs[0]?.modelSelection).toEqual(h.fixture.modelSelection);
        expect(runs[0]?.fallbackReason).toBe("usage_limit");
        expect(runs[0]?.fallbackResetAt).toBe("2099-01-01T00:00:00.000Z");
        yield* sql`UPDATE agents SET backoff_until = NULL WHERE agent_id = ${h.fixture.id}`;
        expect(yield* agents.trigger(task, "fallback:second", task.prompt)).toBe(true);
        expect(h.launches.at(-1)?.modelSelection).toEqual(fallback);
        const secondRuns = yield* store.runs(h.fixture.id);
        const secondRun = secondRuns.find((run) => run.id === "agent-work:fallback:second");
        expect(secondRun?.modelSelection).toEqual(fallback);
        expect(secondRun?.fallbackReason).toBe("usage_limit");
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "owner sends skip a stored same-provider fallback and restore the primary after reset",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const school = { instanceId: ProviderInstanceId.make("codex-school"), model: "gpt-5" };
        const crossProvider = {
          instanceId: ProviderInstanceId.make("claude-backup"),
          model: "opus",
        };
        yield* store.save({
          ...h.fixture,
          fallbackChain: [school, crossProvider],
          fallbackIndex: 1,
          fallbackReason: "usage_limit",
          fallbackUntil: "2099-01-01T00:00:00.000Z",
        });
        yield* agents.send({
          id: h.fixture.id,
          commandId: CommandId.make("send:fallback"),
          messageId: MessageId.make("message:fallback"),
          text: "Continue",
        });
        expect(h.calls.at(-1)?.modelSelection).toEqual(crossProvider);
        expect((yield* store.get(h.fixture.id)).fallbackChain).toEqual([school, crossProvider]);
        yield* store.setFallback(h.fixture.id, {
          index: 2,
          reason: "usage_limit",
          until: "1970-01-01T00:00:00.000Z",
        });
        yield* agents.send({
          id: h.fixture.id,
          commandId: CommandId.make("send:restored"),
          messageId: MessageId.make("message:restored"),
          text: "Continue",
        });
        expect(h.calls.at(-1)?.modelSelection).toEqual(h.fixture.modelSelection);
        expect((yield* store.get(h.fixture.id)).fallbackIndex).toBe(0);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("deleting an agent stops active work and removes triggers and memory", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agents = yield* Agents.AgentService;
      const schedules = yield* Schedules.ScheduledTaskService;
      yield* store.save(h.fixture);
      yield* store.remember({ agentId: h.fixture.id, text: "green" });
      const { task } = yield* schedules.upsert(h.triggerInput);
      yield* agents.trigger(task, "delete-active", task.prompt);
      expect((yield* agents.delete(h.fixture.id)).deleted).toBe(true);
      expect(h.commands.filter((command) => command.type === "thread.stop")).toHaveLength(2);
      expect((yield* schedules.list()).tasks).toEqual([]);
      expect(yield* store.list()).toEqual([]);
      expect((yield* agents.delete(h.fixture.id)).deleted).toBe(false);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("creates a conversation without a provider turn and edits the agent in place", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AgentService;
      const { name, avatar, instructions, modelSelection, runtimeMode, projectId, dailyRunCap } =
        h.fixture;
      const input = {
        name,
        avatar,
        instructions,
        modelSelection,
        runtimeMode,
        projectId,
        dailyRunCap,
      };
      const created = yield* agents.upsert(input);
      expect(h.launches).toHaveLength(1);
      expect(h.launches[0]?.initialMessage).toBeUndefined();
      expect(h.launches[0]?.agent?.role).toBe("conversation");
      const edited = yield* agents.upsert({ ...input, id: created.agent.id, name: "Pine" });
      expect(edited.agent.name).toBe("Pine");
      expect(edited.agent.conversationThreadId).toBe(created.agent.conversationThreadId);
      expect(h.launches).toHaveLength(1);
      expect(h.commands.map((command) => command.type)).toEqual([
        "thread.runtime-mode.set",
        "thread.metadata.update",
      ]);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("editing an agent without its fallback chain keeps the fallback position", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agents = yield* Agents.AgentService;
      const { name, avatar, instructions, modelSelection, runtimeMode, projectId, dailyRunCap } =
        h.fixture;
      const fallback = { instanceId: ProviderInstanceId.make("claude-backup"), model: "opus" };
      const created = yield* agents.upsert({
        name,
        avatar,
        instructions,
        modelSelection,
        runtimeMode,
        projectId,
        dailyRunCap,
        fallbackChain: [fallback],
      });
      yield* store.setFallback(created.agent.id, {
        index: 1,
        reason: "usage_limit",
        until: "2099-01-01T00:00:00.000Z",
      });
      // A profile edit that does not carry the chain must not restart it.
      const edited = yield* agents.upsert({
        avatar,
        instructions,
        modelSelection,
        runtimeMode,
        projectId,
        dailyRunCap,
        id: created.agent.id,
        name: "Pine",
      });
      expect(edited.agent.fallbackChain).toEqual([fallback]);
      expect(edited.agent.fallbackIndex).toBe(1);
      expect(edited.agent.fallbackReason).toBe("usage_limit");
      expect(edited.agent.fallbackUntil).toBe("2099-01-01T00:00:00.000Z");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("files an agent's conversation in a project and moves it between projects in place", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agents = yield* Agents.AgentService;
      const labels = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const conversation = h.fixture.conversationThreadId;
      const at = h.fixture.createdAt;
      const config = yield* ServerConfig.ServerConfig;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${h.fixture.projectId},'No project',${`${config.baseDir}/scratch`},'[]',${at},${at})`;
      // An ongoing conversation with turns, which an ordinary chat could only fork.
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${conversation},${h.fixture.projectId},'Juniper','codex','full-access','default',${at},${at},${JSON.stringify({ agent: { id: h.fixture.id, role: "conversation" } })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('conversation:run',${conversation},1,'codex','completed',${at},'{}')`;
      yield* store.save(h.fixture);
      const spawn = (yield* labels.create({ name: "Spawn Partners" })).label.id;
      const health = (yield* labels.create({ name: "Health" })).label.id;
      expect((yield* store.get(h.fixture.id)).projectFolderId).toBeNull();

      const moved = yield* agents.setProject({ id: h.fixture.id, projectFolderId: spawn });
      expect(moved.agent.projectFolderId).toBe(spawn);
      expect((yield* labels.getThreadLabels(conversation)).labels.map((l) => l.labelId)).toEqual([
        spawn,
      ]);
      // Saving the profile keeps the derived project out of the stored payload.
      const { name, avatar, instructions, modelSelection, runtimeMode, projectId, dailyRunCap } =
        h.fixture;
      const profile = { name, avatar, instructions, modelSelection, runtimeMode, projectId };
      const edited = yield* agents.upsert({ ...profile, dailyRunCap, id: h.fixture.id });
      expect(edited.agent.projectFolderId).toBe(spawn);
      const payload = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM agents WHERE agent_id = ${h.fixture.id}`;
      expect(JSON.parse(payload[0]!.payload_json)).not.toHaveProperty("projectFolderId");

      const rehomed = yield* agents.upsert({
        ...profile,
        dailyRunCap,
        id: h.fixture.id,
        projectFolderId: health,
      });
      expect(rehomed.agent.projectFolderId).toBe(health);
      expect(rehomed.agent.conversationThreadId).toBe(conversation);
      expect((yield* agents.list()).agents.map((agent) => agent.projectFolderId)).toEqual([health]);
      expect(
        (yield* agents.setProject({ id: h.fixture.id, projectFolderId: null })).agent
          .projectFolderId,
      ).toBeNull();
      // No fork and no new thread: the agent keeps its one conversation.
      expect(h.launches).toHaveLength(0);
      expect(h.commands.some((command) => command.type === "thread.fork")).toBe(false);
      const missing = yield* agents
        .setProject({ id: h.fixture.id, projectFolderId: ProjectLabelId.make("label:gone") })
        .pipe(Effect.flip);
      expect(missing.message).toBe("That project no longer exists.");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("recovers an interrupted job with no work thread once and delivers its failure", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agents = yield* Agents.AgentService;
      yield* store.save(h.fixture);
      yield* store.createRun({
        id: "orphan",
        agentId: h.fixture.id,
        triggerId: ScheduledTaskId.make("trigger:orphan"),
        workThreadId: ThreadId.make("missing"),
        status: "starting",
        createdAt: DateTime.formatIso(yield* DateTime.now),
        completedAt: null,
        summary: null,
        posted: false,
      });
      yield* TestClock.adjust("6 minutes");
      yield* agents.reconcile();
      yield* agents.reconcile();
      yield* agents.reconcile();
      expect((yield* store.get(h.fixture.id)).consecutiveFailures).toBe(1);
      expect(h.posts).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  }),
);

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

describe("agent scope, approvals and shared commitments", () => {
  it.effect("new agents start with read, draft and execute and retain mission separately", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AgentService;
        const store = yield* Store.AgentStore;
        const created = (yield* agents.upsert({
          ...h.fixture,
          id: undefined,
          responsibility: "Monitor CI",
          permissions: undefined,
          notifyPolicy: undefined,
        })).agent;
        expect(created).toMatchObject({
          responsibility: "Monitor CI",
          instructions: h.fixture.instructions,
          permissions: defaultAgentPermissions,
        });
        expect(yield* store.reserve(created.id)).toBe(true);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "start-Work without the execute grant produces an approval; approval launches once through the ordinary service",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const workspace = yield* Workspace.AgentWorkspaceService;
          const policy = yield* Policy.AgentMcpPolicy;
          const agent = yield* store.save({
            ...h.fixture,
            permissions: { ...defaultAgentPermissions, execute: false },
          });
          const denied = yield* policy
            .beforeTool(
              scopeFor(agent.conversationThreadId),
              "thread_launch",
              { title: "Fix CI", message: "Repair tests" },
              false,
            )
            .pipe(Effect.flip);
          expect(denied.code).toBe("agent_approval_required");
          expect(h.launches).toHaveLength(0);
          const approval = (yield* workspace.listApprovals({
            agentId: agent.id,
            status: "pending",
          })).approvals[0]!;
          expect(approval.actionKind).toBe("start_work");
          const results = yield* Effect.all(
            [workspace.approve(approval.id), workspace.approve(approval.id)],
            { concurrency: "unbounded" },
          );
          expect(results[0]!.approval.status).toBe("approved");
          expect(results[0]!.approval.resultThreadId).toBe(results[1]!.approval.resultThreadId);
          expect(h.launches).toHaveLength(1);
          expect(h.launches[0]!.reuseExistingThread).toBeUndefined();
          expect(h.launches[0]).toMatchObject({
            agent: { id: agent.id, role: "work" },
            workOrigin: "agent",
            sourceAgentId: agent.id,
            sourceThreadId: agent.conversationThreadId,
            workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
          });
          const identity = yield* store.forThread(results[0]!.approval.resultThreadId!);
          expect(identity?.id).toBe(agent.id);
          expect((yield* workspace.activity(agent.id)).actions.map((a) => a.kind)).toEqual(
            expect.arrayContaining(["approval_requested", "work_started"]),
          );
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["execute", "no_execute"] as const)(
    "work_start with %s persists Work provenance and its source run",
    (grant) =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const sql = yield* SqlClient.SqlClient;
          const workspace = yield* Workspace.AgentWorkspaceService;
          const policy = yield* Policy.AgentMcpPolicy;
          const agent = yield* store.save({
            ...h.fixture,
            permissions: { ...h.fixture.permissions, execute: grant === "execute" },
          });
          const runPayload = yield* encodeUnknown({ modelSelection: agent.modelSelection });
          yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('source-run', ${agent.conversationThreadId}, 1, 'codex', 'running', ${agent.createdAt}, ${runPayload})`;
          const input = {
            commandId: "stable-work",
            targetProjectId: agent.projectId,
            title: "Repair",
            scopeSummary: "Repair CI",
            workspace: "local",
          };
          const invoke = policy.beforeTool(
            scopeFor(agent.conversationThreadId),
            "work_start",
            input,
            false,
          );
          let threadId: ThreadId;
          if (grant === "no_execute") {
            expect((yield* invoke.pipe(Effect.flip)).code).toBe("agent_approval_required");
            expect((yield* invoke.pipe(Effect.flip)).code).toBe("agent_approval_required");
            expect(h.launches).toHaveLength(0);
            const approvals = (yield* workspace.listApprovals({})).approvals;
            expect(approvals).toHaveLength(1);
            threadId = (yield* workspace.approve(approvals[0]!.id)).approval.resultThreadId!;
          } else {
            const decision = yield* invoke;
            expect(decision.handled).toBe(true);
            threadId = h.launches[0]!.threadId!;
            expect(decision.result).toEqual({ threadId });
          }
          expect(h.launches[0]).toMatchObject({
            threadId,
            workOrigin: "agent",
            sourceAgentId: agent.id,
            sourceAgentRunId: "source-run",
            sourceThreadId: agent.conversationThreadId,
            agent: { id: agent.id, role: "work" },
            workspaceStrategy: { type: "root" },
          });
          expect(h.launches[0]!.initialMessage!.text).toContain("Repair CI");
          expect(h.commands).toContainEqual(
            expect.objectContaining({ type: "work.handoff.record", targetThreadId: threadId }),
          );
          expect(
            yield* sql`SELECT source_run_id FROM agent_run_threads WHERE thread_id = ${threadId}`,
          ).toEqual([{ source_run_id: "source-run" }]);
          expect((yield* workspace.activity(agent.id)).actions).toContainEqual(
            expect.objectContaining({
              kind: "work_started",
              targetId: threadId,
              runId: "source-run",
            }),
          );
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("work_start leaves non-agent callers on the existing Work path", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const policy = yield* Policy.AgentMcpPolicy;
        expect(
          yield* policy.beforeTool(
            scopeFor(h.fixture.conversationThreadId),
            "work_start",
            {},
            false,
          ),
        ).toEqual({ handled: false });
        expect(
          yield* policy.beforeTool(
            { ...scopeFor(h.fixture.conversationThreadId), thread: undefined },
            "work_start",
            {},
            false,
          ),
        ).toEqual({ handled: false });
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "agents cannot self-grant; rejected proposals execute nothing and approved grants use owner upsert",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const workspace = yield* Workspace.AgentWorkspaceService;
          const agent = yield* store.save({
            ...h.fixture,
            permissions: { ...defaultAgentPermissions, execute: false },
          });
          const actor = { agent, threadId: agent.conversationThreadId };
          const action = {
            actionKind: "change_permissions" as const,
            payload: { permissions: h.fixture.permissions },
          };
          const first = yield* workspace.requestApproval(agent.id, action, actor);
          expect((yield* store.get(agent.id)).permissions.execute).toBe(false);
          yield* workspace.reject(first.approval.id);
          expect((yield* Effect.result(workspace.approve(first.approval.id)))._tag).toBe("Failure");
          expect((yield* store.get(agent.id)).permissions.execute).toBe(false);
          const second = yield* workspace.requestApproval(agent.id, action, actor);
          yield* workspace.approve(second.approval.id);
          expect((yield* store.get(agent.id)).permissions.execute).toBe(true);
          expect(h.commands.map((c) => c.type)).toContain("thread.runtime-mode.set");
          const other = yield* store.save(agentFixture("other"));
          expect(
            (yield* Effect.result(workspace.requestApproval(other.id, action, actor)))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect(
    "even an autonomous agent must propose a trigger, and approval creates the owner-visible schedule",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const agent = yield* (yield* Store.AgentStore).save(h.fixture);
          const workspace = yield* Workspace.AgentWorkspaceService;
          const policy = yield* Policy.AgentMcpPolicy;
          const denied = yield* policy
            .beforeTool(
              scopeFor(agent.conversationThreadId),
              "schedule_task",
              {
                title: "Morning review",
                prompt: "Review commitments",
                schedule: { type: "interval", everyMs: 60000 },
              },
              false,
            )
            .pipe(Effect.flip);
          expect(denied.code).toBe("agent_approval_required");
          const schedules = yield* Schedules.ScheduledTaskService;
          expect((yield* schedules.list()).tasks).toHaveLength(0);
          const proposal = (yield* workspace.listApprovals({ status: "pending" })).approvals[0]!;
          yield* workspace.approve(proposal.id);
          expect((yield* schedules.list()).tasks[0]).toMatchObject({
            agentId: agent.id,
            title: "Morning review",
          });
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("agents share labeled commitments in every project, without copying memory", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const workspace = yield* Workspace.AgentWorkspaceService;
        const labels = yield* Labels.ProjectLabelService;
        const label = (yield* labels.create({ name: "Spawn" })).label.id;
        const other = (yield* labels.create({ name: "Private" })).label.id;
        const sql = yield* SqlClient.SqlClient;
        const a = yield* store.save({ ...h.fixture, permissions: defaultAgentPermissions });
        const b = yield* store.save(agentFixture("engineering"));
        // Agents see every project; only the read permission withholds shared items.
        const outsider = yield* store.save({
          ...agentFixture("outsider"),
          permissions: { ...defaultAgentPermissions, read: false },
        });
        const input = {
          title: "Follow up with DSO",
          description: "Email the contact",
          owner: { kind: "user" as const },
          dueAt: null,
          reminderAt: null,
          waitingOn: null,
          labelIds: [label],
          agentId: a.id,
          sourceRefs: [{ kind: "thread" as const, id: a.conversationThreadId }],
          evidenceRefs: [],
        };
        const proposed = (yield* workspace.createCommitment(input, {
          agent: a,
          threadId: a.conversationThreadId,
        })).commitment;
        expect(proposed.status).toBe("proposed");
        expect(
          (yield* workspace.listCommitments(
            {},
            { agent: b, threadId: b.conversationThreadId },
          )).commitments.map((c) => c.id),
        ).toEqual([proposed.id]);
        expect(
          (yield* workspace.listCommitments({ agentId: b.id })).commitments.map((c) => c.id),
        ).toEqual([proposed.id]);
        expect(
          (yield* workspace.listCommitments(
            { labelId: label },
            { agent: outsider, threadId: outsider.conversationThreadId },
          )).commitments,
        ).toEqual([]);
        const elsewhere = (yield* workspace.createCommitment(
          { ...input, title: "Another project", labelIds: [other] },
          { agent: a, threadId: a.conversationThreadId },
        )).commitment;
        expect(
          (yield* workspace.listCommitments(
            { labelId: other },
            { agent: b, threadId: b.conversationThreadId },
          )).commitments.map((c) => c.id),
        ).toEqual([elsewhere.id]);
        yield* workspace.deleteCommitment(elsewhere.id);
        expect(
          (yield* Effect.result(
            workspace.updateCommitmentStatus(
              { id: proposed.id, status: "done", why: "Claimed done", evidenceRefs: [] },
              { agent: b, threadId: b.conversationThreadId },
            ),
          ))._tag,
        ).toBe("Failure");
        yield* workspace.confirmCommitment({ id: proposed.id, why: "This is a real obligation" });
        const done = yield* workspace.updateCommitmentStatus(
          {
            id: proposed.id,
            status: "done",
            why: "Contact replied",
            evidenceRefs: [{ kind: "url", id: "https://example.com/evidence" }],
          },
          { agent: b, threadId: b.conversationThreadId },
        );
        expect(done.commitment.status).toBe("done");
        const visible = (yield* workspace.listCommitments(
          { status: "done" },
          { agent: a, threadId: a.conversationThreadId },
        )).commitments;
        expect(visible[0]!.evidenceRefs).toEqual(done.commitment.evidenceRefs);
        const history = (yield* workspace.commitmentHistory(proposed.id)).history;
        expect(history.map((r) => r.toStatus)).toEqual(["proposed", "open", "done"]);
        expect(history.at(-1)).toMatchObject({
          who: `agent:${b.id}`,
          why: "Contact replied",
          evidenceRefs: done.commitment.evidenceRefs,
        });
        expect(yield* store.memory(b.id)).toEqual([]);
        expect(
          (yield* workspace.listCommitments({ agentId: outsider.id, labelId: label })).commitments,
        ).toEqual([]);
        const removable = (yield* workspace.createCommitment({ ...input, title: "Remove me" }))
          .commitment;
        expect((yield* workspace.commitmentHistory(removable.id)).history.length).toBeGreaterThan(
          0,
        );
        expect(yield* workspace.deleteCommitment(removable.id)).toEqual({ deleted: true });
        expect(yield* workspace.deleteCommitment(removable.id)).toEqual({ deleted: false });
        expect(
          yield* sql`SELECT * FROM commitment_history WHERE commitment_id = ${removable.id}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT * FROM commitment_labels WHERE commitment_id = ${removable.id}`,
        ).toEqual([]);
        yield* labels.delete(label);
        expect((yield* workspace.listCommitments({ labelId: label })).commitments).toEqual([]);
        expect((yield* workspace.listCommitments({})).commitments[0]!.labelIds).toEqual([]);
        expect((yield* Effect.result(workspace.createCommitment(input)))._tag).toBe("Failure");
        expect(
          (yield* workspace.listCommitments({}, { agent: b, threadId: b.conversationThreadId }))
            .commitments,
        ).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "activity uses real persisted process state and never invents runs from agent claims",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const agent = yield* (yield* Store.AgentStore).save(h.fixture);
          const workspace = yield* Workspace.AgentWorkspaceService;
          const sql = yield* SqlClient.SqlClient;
          expect((yield* workspace.activity(agent.id)).runs).toEqual([]);
          const run = {
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: null,
            modelSelection: agent.modelSelection,
          };
          const payload = yield* encodeUnknown(run);
          yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('actual-run', ${agent.conversationThreadId}, 1, 'codex', 'waiting', ${agent.createdAt}, ${payload})`;
          yield* workspace.createCommitment({
            title: "A claim is not a run",
            description: "Done",
            owner: { kind: "user" },
            dueAt: null,
            reminderAt: null,
            waitingOn: null,
            labelIds: [],
            agentId: agent.id,
            sourceRefs: [],
            evidenceRefs: [],
          });
          const activity = yield* workspace.activity(agent.id);
          expect(activity.runs).toHaveLength(1);
          expect(activity.runs[0]).toMatchObject({
            id: "actual-run",
            status: "waiting",
            triggerKind: "owner_message",
            startedAt: run.startedAt,
            finishedAt: null,
            modelSelection: agent.modelSelection,
            summary: null,
          });
          expect(activity.actions).toEqual([]);
          yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('queued-next', ${agent.conversationThreadId}, 2, 'codex', 'queued', ${agent.createdAt}, ${payload})`;
          yield* workspace.logAction(
            { agent, threadId: agent.conversationThreadId },
            "commitment_touched",
            "item-id",
          );
          expect((yield* workspace.activity(agent.id)).actions[0]).toMatchObject({
            runId: "actual-run",
            targetId: "item-id",
          });
        }).pipe(Effect.provide(h.layer));
      }),
  );
});

it.effect(
  "old proposals expire without executing and a revoked grant takes effect during an invocation",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const workspace = yield* Workspace.AgentWorkspaceService;
        const policy = yield* Policy.AgentMcpPolicy;
        const agent = yield* store.save(h.fixture);
        const actor = { agent, threadId: agent.conversationThreadId };
        const { approval } = yield* workspace.requestApproval(
          agent.id,
          {
            actionKind: "start_work",
            payload: {
              agentId: agent.id,
              projectId: agent.projectId!,
              title: "Old intent",
              prompt: "Outdated change",
            },
          },
          actor,
        );
        yield* TestClock.adjust("8 days");
        expect((yield* workspace.listApprovals({ status: "expired" })).approvals[0]!.id).toBe(
          approval.id,
        );
        expect((yield* Effect.result(workspace.approve(approval.id)))._tag).toBe("Failure");
        yield* store.save({ ...agent, permissions: { ...agent.permissions, execute: false } });
        const stale = yield* workspace.startWork(
          {
            agentId: agent.id,
            projectId: agent.projectId!,
            title: "Stale authority",
            prompt: "Do it",
          },
          actor,
        );
        expect(stale.threadId).toBeNull();
        expect(stale.approval?.status).toBe("pending");
        expect(
          (yield* Effect.result(
            policy.beforeTool(scopeFor(actor.threadId), "pending_request_respond", {}, false),
          ))._tag,
        ).toBe("Failure");
        expect(h.launches).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "notification policy suppresses routine success and still surfaces real waiting state",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        yield* store.save({ ...h.fixture, notifyPolicy: "action_required" });
        const { task } = yield* schedules.upsert(h.triggerInput);
        yield* agents.trigger(task, "quiet", task.prompt);
        yield* agents.reconcile();
        expect(h.posts).toHaveLength(0);
        yield* agents.trigger(task, "needs-input", task.prompt);
        const last = h.launches.at(-1)!;
        const projection = h.projections.get(last.threadId!)!;
        h.projections.set(last.threadId!, {
          ...projection,
          runs: projection.runs.map((r) => ({ ...r, status: "waiting" })),
        });
        yield* agents.reconcile();
        expect(h.posts).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "execute permission cannot send messages, create PRs, merge, or escape into an untracked provider thread",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const agent = yield* (yield* Store.AgentStore).save({
          ...h.fixture,
          permissions: defaultAgentPermissions,
        });
        const policy = yield* Policy.AgentMcpPolicy;
        for (const name of [
          "send_message",
          "create_pull_request",
          "merge_pull_request",
          "deploy",
          "delete_project",
          "terminal_run",
          "preview_click",
          "preview_type",
          "create_threads",
          "delegate_task",
          "thread_configure",
          "pending_request_respond",
        ]) {
          const result = yield* policy
            .beforeTool(scopeFor(agent.conversationThreadId), name, {}, false)
            .pipe(Effect.result);
          expect(result._tag, name).toBe("Failure");
        }
        const workspace = yield* Workspace.AgentWorkspaceService;
        const result = yield* workspace.startWork(
          {
            agentId: agent.id,
            projectId: agent.projectId!,
            title: "Bounded change",
            prompt: "Repair CI",
          },
          { agent, threadId: agent.conversationThreadId },
        );
        expect(result.approval).toBeNull();
        expect(result.threadId).not.toBeNull();
        expect(
          (yield* policy.beforeTool(
            scopeFor(agent.conversationThreadId),
            "start_agent_work",
            { projectId: "another-project" },
            false,
          )).handled,
        ).toBe(false);
        expect(
          (yield* Effect.result(
            policy.beforeTool(
              scopeFor(agent.conversationThreadId),
              "project_read",
              { projectId: "another-project", labelId: "spawn" },
              true,
            ),
          ))._tag,
        ).toBe("Failure");
        const escaped = yield* workspace.startWork(
          {
            agentId: agent.id,
            projectId: agent.projectId!,
            title: "Different path",
            prompt: "Repair CI",
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/unapproved" },
          },
          { agent, threadId: agent.conversationThreadId },
        );
        expect(escaped.threadId).toBeNull();
        expect(escaped.approval?.status).toBe("pending");
        expect(h.launches).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect.each([
  "computer_press",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_drag",
  "computer_open_app",
])("agents use %s with default grants and lose access when execute is revoked", (name) =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const policy = yield* Policy.AgentMcpPolicy;
      const agent = yield* store.save({ ...h.fixture, permissions: defaultAgentPermissions });
      const scope = scopeFor(agent.conversationThreadId);
      expect(yield* policy.beforeTool(scope, name, {}, false)).toEqual({ handled: false });
      yield* store.save({ ...agent, permissions: { ...agent.permissions, execute: false } });
      const denied = yield* policy.beforeTool(scope, name, {}, false).pipe(Effect.flip);
      expect(denied.code).toBe("agent_permission_denied");
      expect(denied.message).toBe("This agent has no execute grant.");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("agents add projects with the execute grant, without the high-impact grants", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const policy = yield* Policy.AgentMcpPolicy;
      const agent = yield* store.save({ ...h.fixture, permissions: defaultAgentPermissions });
      const call = (name: string) =>
        policy.beforeTool(scopeFor(agent.conversationThreadId), name, { title: "New app" }, false);
      for (const name of ["project_create", "project_clone"])
        expect(yield* call(name), name).toEqual({ handled: false });
      expect((yield* call("project_delete").pipe(Effect.flip)).code).toBe(
        "agent_permission_denied",
      );
      yield* store.save({ ...agent, permissions: { ...agent.permissions, execute: false } });
      expect((yield* call("project_create").pipe(Effect.flip)).code).toBe(
        "agent_permission_denied",
      );
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each(["execute", "no_agent_execute", "no_read"] as const)(
  "Work in any live repository follows the agent's %s permission",
  (policyKind) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // No project tag or link: every live repository is in reach.
        const repositoryId = ProjectId.make("patient-outreach");
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repositoryId},'Patient Outreach','/outreach','[]',${h.fixture.createdAt},${h.fixture.createdAt})`;
        const agent = yield* (yield* Store.AgentStore).save({
          ...h.fixture,
          permissions: {
            ...h.fixture.permissions,
            execute: policyKind !== "no_agent_execute",
            read: policyKind !== "no_read",
          },
        });
        const workspace = yield* Workspace.AgentWorkspaceService;
        const policy = yield* Policy.AgentMcpPolicy;
        const result = yield* workspace.startWork(
          {
            agentId: agent.id,
            projectId: repositoryId,
            title: "Repair outreach",
            prompt: "Fix CI",
          },
          { agent, threadId: agent.conversationThreadId },
        );
        if (policyKind === "execute") {
          expect(result.approval).toBeNull();
          expect(h.launches[0]?.projectId).toBe(repositoryId);
          expect(
            yield* policy.beforeTool(
              scopeFor(agent.conversationThreadId),
              "project_read",
              { projectId: repositoryId },
              true,
            ),
          ).toEqual({ handled: false });
          // A running Work thread cannot keep reaching a repository that was removed.
          yield* sql`UPDATE projection_projects SET deleted_at = ${h.fixture.createdAt} WHERE project_id = ${repositoryId}`;
          expect(
            (yield* policy
              .beforeTool(
                scopeFor(result.threadId!),
                "project_read",
                { projectId: repositoryId },
                true,
              )
              .pipe(Effect.flip)).code,
          ).toBe("agent_permission_denied");
        } else {
          expect(result.threadId).toBeNull();
          expect(result.approval?.status).toBe("pending");
          expect(h.launches).toHaveLength(0);
          // The owner can approve this one reviewed action without changing the agent's grants.
          yield* workspace.approve(result.approval!.id);
          expect(h.launches[0]?.projectId).toBe(repositoryId);
        }
      }).pipe(Effect.provide(h.layer));
    }),
);

describe("event-driven agent triggers", () => {
  const setup = Effect.gen(function* () {
    const h = yield* makeHarness;
    return h;
  });
  const completedEvent = (h: Effect.Success<typeof setup>, key = "source") => {
    const threadId = ThreadId.make(`work:${key}`);
    const run = h.runFor(threadId);
    const projection = idleThreadProjection({
      ...liveThreadShell(threadId),
      projectId: h.fixture.projectId!,
    });
    h.projections.set(threadId, { ...projection, runs: [run] });
    return {
      sequence: 1,
      commandId: null,
      event: {
        id: EventId.make(`done:${key}`),
        type: "run.updated",
        threadId,
        occurredAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
        payload: run,
      },
    } satisfies OrchestrationV2StoredEvent;
  };
  const prepare = (
    h: Effect.Success<typeof setup>,
    event: AgentEventContext["kind"] = "work.completed",
  ) =>
    Effect.gen(function* () {
      yield* (yield* Store.AgentStore).save({ ...h.fixture, dailyRunCap: 20 });
      return yield* (yield* Schedules.ScheduledTaskService).upsert({
        ...h.triggerInput,
        schedule: { type: "event", event },
      });
    });
  it.effect("events in any live repository wake the agent, with no project grant", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        yield* prepare(h);
        const sql = yield* SqlClient.SqlClient;
        const repositoryId = ProjectId.make("patient-outreach");
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repositoryId},'Patient Outreach','/outreach','[]',${h.fixture.createdAt},${h.fixture.createdAt})`;
        const source = completedEvent(h, "elsewhere");
        const projection = h.projections.get(source.event.threadId)!;
        h.projections.set(source.event.threadId, {
          ...projection,
          thread: { ...projection.thread, projectId: repositoryId },
        });
        yield* (yield* EventReactor.AgentEventReactor).observe(source);
        yield* (yield* AgentEvents.AgentEventBus).drain;
        expect(h.launches).toHaveLength(1);
        expect(
          (yield* (yield* Store.AgentStore).runs(h.fixture.id))[0]?.triggerContext?.projectId,
        ).toBe(repositoryId);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "event filters reject missing repositories and labels on create and update, and Run now requires a source event",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const { task } = yield* prepare(h);
          const schedules = yield* Schedules.ScheduledTaskService;
          const labels = yield* Labels.ProjectLabelService;
          const granted = (yield* labels.create({ name: "Granted" })).label;
          const deleted = (yield* labels.create({ name: "Deleted" })).label;
          yield* labels.delete(deleted.id);
          for (const filter of [
            { projectIds: [ProjectId.make("missing-repo")] },
            { labelIds: [granted.id, deleted.id] },
          ]) {
            for (const id of [undefined, task.id]) {
              const error = yield* schedules
                .upsert({
                  ...h.triggerInput,
                  ...(id ? { id } : {}),
                  schedule: { type: "event", event: "work.completed", filter },
                })
                .pipe(Effect.flip);
              expect(error).toMatchObject({
                _tag: "ScheduledTaskError",
                code: "event_filter_out_of_scope",
              });
            }
          }
          yield* schedules.upsert({
            ...h.triggerInput,
            id: task.id,
            schedule: {
              type: "event",
              event: "work.completed",
              filter: { projectIds: [h.fixture.projectId!], labelIds: [granted.id] },
            },
          });
          // Restore the original filter before checking that a manual run has no side effects.
          yield* schedules.upsert({ ...h.triggerInput, id: task.id, schedule: task.schedule });
          expect((yield* schedules.list()).tasks).toHaveLength(1);
          expect((yield* schedules.list()).tasks[0]?.schedule).toEqual(task.schedule);
          expect(yield* schedules.runNow({ id: task.id }).pipe(Effect.flip)).toMatchObject({
            _tag: "ScheduledTaskError",
            code: "event_run_now_unsupported",
          });
          expect(h.launches).toHaveLength(0);
          expect(yield* (yield* Store.AgentStore).runs(h.fixture.id)).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect(
    "Work completion matches once, persists its refs, and cursor replay after restart does not refire",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const { task } = yield* prepare(h);
          expect(task.nextRunAt).toBeNull();
          const source = completedEvent(h);
          const events = yield* EventStore.EventStoreV2;
          yield* events.append({ events: [source.event] });
          yield* (yield* EventReactor.AgentEventReactor).tick;
          expect(h.launches).toHaveLength(1);
          expect((yield* (yield* Schedules.ScheduledTaskService).list()).tasks[0]).toMatchObject({
            runCount: 1,
            lastRunStatus: "succeeded",
          });
          const store = yield* Store.AgentStore;
          expect((yield* store.runs(h.fixture.id))[0]).toMatchObject({
            triggerKind: "event",
            triggerContext: {
              kind: "work.completed",
              refs: { threadId: source.event.threadId, runId: source.event.payload.id },
            },
          });
          const sql = yield* SqlClient.SqlClient;
          const workThreadId = h.launches[0]!.threadId!;
          const payload = yield* encodeUnknown({
            startedAt: null,
            completedAt: null,
            modelSelection: h.fixture.modelSelection,
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('event-provider-run', ${workThreadId}, 1, 'codex', 'running', ${h.fixture.createdAt}, ${payload})`;
          const activity = yield* (yield* Workspace.AgentWorkspaceService).activity(h.fixture.id);
          expect(activity.runs[0]).toMatchObject({
            triggerKind: "event",
            triggerContext: { kind: "work.completed", refs: { threadId: source.event.threadId } },
          });
          yield* sql`UPDATE agent_events SET dispatched = 0`;
          // Simulate process loss by recreating both event services over the same DB.
          yield* Effect.gen(function* () {
            const reactor = yield* EventReactor.AgentEventReactor;
            yield* reactor.tick;
            yield* reactor.observe(source);
            yield* (yield* AgentEvents.AgentEventBus).drain;
          }).pipe(
            Effect.provide(
              EventReactor.layer.pipe(
                Layer.provideMerge(AgentEvents.layer.pipe(Layer.provide(layerSharedIdentity))),
              ),
            ),
          );
          expect(h.launches).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
  );
  it.effect.each(["repository default", "explicit override excludes", "explicit override matches"])(
    "matches event folder filters using %s",
    (membership) =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const { task } = yield* prepare(h);
          const folders = yield* Labels.ProjectLabelService;
          const a = (yield* folders.create({ name: "Repository folder" })).label.id;
          const b = (yield* folders.create({ name: "Explicit folder" })).label.id;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${h.fixture.projectId!},'Repo','/repo','[]',${h.fixture.createdAt},${h.fixture.createdAt})`;
          yield* folders.linkRepository({ labelId: a, repositoryId: h.fixture.projectId! });
          const source = completedEvent(h, "folder");
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${source.event.threadId},${h.fixture.projectId!},'Work','codex','full-access','default',${h.fixture.createdAt},${h.fixture.createdAt},'{"surface":"work"}')`;
          // Historical filing is retained as-is; new filing now requires a linked repository.
          if (membership !== "repository default")
            yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${source.event.threadId},${b})`;
          const expectedFolder = membership === "explicit override matches" ? b : a;
          yield* (yield* Schedules.ScheduledTaskService).upsert({
            ...h.triggerInput,
            id: task.id,
            schedule: {
              type: "event",
              event: "work.completed",
              filter: { labelIds: [expectedFolder] },
            },
          });
          yield* (yield* EventReactor.AgentEventReactor).observe(source);
          yield* (yield* AgentEvents.AgentEventBus).drain;
          expect(h.launches).toHaveLength(membership === "explicit override excludes" ? 0 : 1);
          if (membership !== "explicit override excludes")
            expect(
              (yield* (yield* Store.AgentStore).runs(h.fixture.id))[0]?.triggerContext?.labelIds,
            ).toEqual([expectedFolder]);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["missing repository", "tagged missing repository", "home with unrelated tag"])(
    "uses repository liveness for %s",
    (reason) =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          yield* prepare(h);
          const source = completedEvent(h);
          if (reason === "missing repository" || reason === "tagged missing repository") {
            const p = h.projections.get(source.event.threadId)!;
            h.projections.set(source.event.threadId, {
              ...p,
              thread: { ...p.thread, projectId: ProjectId.make("other") },
            });
          }
          if (reason === "tagged missing repository" || reason === "home with unrelated tag") {
            const label = (yield* (yield* Labels.ProjectLabelService).create({ name: "Private" }))
              .label;
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${source.event.threadId}, ${label.id})`;
          }
          yield* (yield* EventReactor.AgentEventReactor).observe(source);
          yield* (yield* AgentEvents.AgentEventBus).drain;
          expect(h.launches).toHaveLength(reason === "home with unrelated tag" ? 1 : 0);
        }).pipe(Effect.provide(h.layer));
      }),
  );
  it.effect(
    "a self-triggering completion chain stops at depth two and dedups each event per agent",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          yield* prepare(h);
          const bus = yield* AgentEvents.AgentEventBus;
          const reactor = yield* EventReactor.AgentEventReactor;
          const source = completedEvent(h);
          yield* reactor.observe(source);
          yield* bus.drain;
          expect(h.launches).toHaveLength(1);
          for (let i = 0; i < 2; i++) {
            let threadId = h.launches.at(-1)!.threadId!;
            if (i === 1) {
              const parent = threadId;
              threadId = ThreadId.make("governed-child");
              const child = completedEvent(h, "child");
              h.projections.set(threadId, {
                ...h.projections.get(child.event.threadId)!,
                thread: {
                  ...h.projections.get(child.event.threadId)!.thread,
                  id: threadId,
                },
                runs: [h.runFor(threadId)],
              });
              const sql = yield* SqlClient.SqlClient;
              yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind, source_run_id) VALUES (${threadId}, ${h.fixture.id}, 'work', ${parent})`;
            }
            const projection = h.projections.get(threadId)!;
            h.projections.set(threadId, {
              ...projection,
              thread: {
                ...projection.thread,
                projectId: h.fixture.projectId!,
                agent: { id: h.fixture.id, role: "work" },
              },
            });
            const run = projection.runs[0]!;
            const stored: OrchestrationV2StoredEvent = {
              sequence: i + 2,
              commandId: null,
              event: {
                type: "run.updated",
                id: EventId.make(`chain:${i}`),
                threadId,
                occurredAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
                payload: run,
              },
            };
            yield* reactor.observe(stored);
            yield* reactor.observe(stored);
            yield* bus.drain;
          }
          expect(h.launches).toHaveLength(2);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            depth: number;
          }>`SELECT json_extract(context_json, '$.chainDepth') AS depth FROM agent_event_deliveries ORDER BY depth`;
          expect(rows.map((r) => r.depth)).toEqual([1, 2]);
        }).pipe(Effect.provide(h.layer));
      }),
  );
  it.effect("PR checks failed dispatches with PR URL and head refs, once per head", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        yield* prepare(h, "pr.checks_failed");
        const source = completedEvent(h);
        const event: OrchestrationV2StoredEvent = {
          sequence: 1,
          commandId: null,
          event: {
            type: "thread.pull-request-link-updated",
            id: EventId.make("pr:checks"),
            threadId: source.event.threadId,
            occurredAt: source.event.occurredAt,
            payload: {
              host: "github.com",
              repository: "owner/repo",
              number: 42,
              url: "https://github.com/owner/repo/pull/42",
              source: "manual",
              linkedAt: "2026-01-01T00:00:00.000Z",
              stack: null,
              snapshot: {
                state: "open",
                title: "Fix",
                headBranch: "fix",
                baseBranch: "main",
                isDraft: false,
                headSha: "abc123",
                updatedAt: "2026-01-02T00:00:00.000Z",
                syncedAt: "2026-01-02T00:00:00.000Z",
                checksState: "failing",
              },
            },
          },
        };
        const reactor = yield* EventReactor.AgentEventReactor;
        const bus = yield* AgentEvents.AgentEventBus;
        yield* reactor.observe(event);
        yield* bus.drain;
        yield* reactor.observe(event);
        yield* bus.drain;
        expect(h.launches).toHaveLength(1);
        expect(
          (yield* (yield* Store.AgentStore).runs(h.fixture.id))[0]?.triggerContext?.refs,
        ).toMatchObject({
          prUrl: "https://github.com/owner/repo/pull/42",
          headSha: "abc123",
          threadId: source.event.threadId,
        });
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("event trigger proposals remain inert until an owner approves them", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        yield* (yield* Store.AgentStore).save(h.fixture);
        const workspace = yield* Workspace.AgentWorkspaceService;
        const { approval } = yield* workspace.requestApproval(
          h.fixture.id,
          {
            actionKind: "schedule_trigger",
            payload: { ...h.triggerInput, schedule: { type: "event", event: "work.completed" } },
          },
          { agent: h.fixture, threadId: h.fixture.conversationThreadId },
        );
        expect((yield* (yield* Schedules.ScheduledTaskService).list()).tasks).toHaveLength(0);
        yield* workspace.approve(approval.id);
        yield* workspace.approve(approval.id);
        expect((yield* (yield* Schedules.ScheduledTaskService).list()).tasks).toHaveLength(1);
        yield* (yield* EventReactor.AgentEventReactor).observe(completedEvent(h));
        yield* (yield* AgentEvents.AgentEventBus).drain;
        expect(h.launches).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("due commitments fire once across ticks and completed obligations stay quiet", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        yield* prepare(h, "commitment.due");
        const workspace = yield* Workspace.AgentWorkspaceService;
        const makeItem = (title: string) =>
          workspace.createCommitment({
            title,
            description: "",
            owner: { kind: "agent", agentId: h.fixture.id },
            dueAt: "1970-01-01T00:00:00.000Z",
            reminderAt: null,
            waitingOn: null,
            labelIds: [],
            agentId: h.fixture.id,
            sourceRefs: [],
            evidenceRefs: [],
          });
        const done = yield* makeItem("Already done");
        yield* workspace.updateCommitmentStatus({
          id: done.commitment.id,
          status: "done",
          why: "Owner confirmed",
          evidenceRefs: [],
        });
        const open = yield* makeItem("Due now");
        const reactor = yield* EventReactor.AgentEventReactor;
        yield* reactor.tick;
        yield* reactor.tick;
        expect(h.launches).toHaveLength(1);
        expect(
          (yield* (yield* Store.AgentStore).runs(h.fixture.id))[0]?.triggerContext,
        ).toMatchObject({
          kind: "commitment.due",
          refs: { commitmentId: open.commitment.id },
        });
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect("busy agents and daily caps defer events durably without duplicate dispatch", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        yield* prepare(h);
        const store = yield* Store.AgentStore;
        yield* store.save({ ...h.fixture, dailyRunCap: 1 });
        const reactor = yield* EventReactor.AgentEventReactor;
        const bus = yield* AgentEvents.AgentEventBus;
        yield* reactor.observe(completedEvent(h, "first"));
        yield* bus.drain;
        yield* reactor.observe(completedEvent(h, "second"));
        yield* bus.drain;
        expect(h.launches).toHaveLength(1);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT 1 FROM agent_events WHERE dispatched = 0`).toHaveLength(1);
        yield* TestClock.adjust("1 day");
        yield* bus.drain;
        yield* bus.drain;
        expect(h.launches).toHaveLength(2);
        expect(yield* sql`SELECT 1 FROM agent_event_deliveries`).toHaveLength(2);
      }).pipe(Effect.provide(h.layer));
    }),
  );
  it.effect(
    "filter labels, repositories and origin narrow matches and overlapping triggers dispatch once",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const { task } = yield* prepare(h);
          const schedules = yield* Schedules.ScheduledTaskService;
          yield* schedules.upsert({
            ...h.triggerInput,
            id: task.id,
            schedule: { type: "event", event: "work.completed", filter: { origin: "agent" } },
          });
          const source = completedEvent(h);
          const reactor = yield* EventReactor.AgentEventReactor;
          const bus = yield* AgentEvents.AgentEventBus;
          yield* reactor.observe(source);
          yield* bus.drain;
          expect(h.launches).toHaveLength(0);
          const next = completedEvent(h, "matching");
          yield* schedules.upsert({
            ...h.triggerInput,
            id: task.id,
            schedule: {
              type: "event",
              event: "work.completed",
              filter: { origin: "direct", projectIds: [h.fixture.projectId!] },
            },
          });
          yield* schedules.upsert({
            ...h.triggerInput,
            schedule: { type: "event", event: "work.completed" },
          });
          yield* reactor.observe(next);
          yield* bus.drain;
          expect(h.launches).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect.each(["work.failed", "work.review_ready"] as const)(
    "derives %s from execution evidence",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          yield* prepare(h, kind);
          const source = completedEvent(h);
          const threadId = source.event.threadId;
          const projection = h.projections.get(threadId)!;
          h.projections.set(threadId, {
            ...projection,
            runs:
              kind === "work.failed"
                ? [{ ...projection.runs[0]!, status: "failed" }]
                : projection.runs,
            checkpoints:
              kind === "work.review_ready"
                ? [
                    {
                      id: CheckpointId.make("ready"),
                      threadId,
                      scopeId: CheckpointScopeId.make("scope"),
                      runId: projection.runs[0]!.id,
                      nodeId: NodeId.make("node"),
                      parentCheckpointId: null,
                      ordinalWithinScope: 1,
                      appRunOrdinal: 1,
                      ref: CheckpointRef.make("refs/checkpoints/ready"),
                      status: "ready",
                      capturedAt: source.event.occurredAt,
                      files: [{ path: "fix.ts", kind: "modified", additions: 1, deletions: 0 }],
                    },
                  ]
                : [],
          });
          yield* (yield* EventReactor.AgentEventReactor).observe(source);
          yield* (yield* AgentEvents.AgentEventBus).drain;
          expect(h.launches).toHaveLength(1);
          expect(
            (yield* (yield* Store.AgentStore).runs(h.fixture.id))[0]?.triggerContext?.kind,
          ).toBe(kind);
        }).pipe(Effect.provide(h.layer));
      }),
  );
});

it.effect.each(["conversation", "work"] as const)(
  "retries a failed %s past a same-provider account with an unknown fallback driver",
  (kind) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const sql = yield* SqlClient.SqlClient;
        const fallback = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
        yield* store.save({
          ...h.fixture,
          fallbackChain: [
            { instanceId: ProviderInstanceId.make("codex-school"), model: "gpt-5" },
            fallback,
          ],
        });
        const threadId =
          kind === "conversation" ? h.fixture.conversationThreadId : ThreadId.make("governed:work");
        if (kind === "work")
          yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES (${threadId}, ${h.fixture.id}, 'work')`;
        const base = h.projections.get(h.fixture.conversationThreadId)!;
        const at = DateTime.makeUnsafe(h.fixture.createdAt);
        const run = {
          id: RunId.make("fallback:failed"),
          threadId,
          ordinal: 1,
          providerInstanceId: h.fixture.modelSelection.instanceId,
          modelSelection: h.fixture.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("fallback:original"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "failed" as const,
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        };
        const projection = {
          ...base,
          thread: { ...base.thread, id: threadId },
          runs: [run],
          messages: [
            {
              id: run.userMessageId,
              threadId,
              runId: run.id,
              nodeId: null,
              role: "user" as const,
              text: "Check CI",
              attachments: [],
              streaming: false,
              createdAt: at,
              updatedAt: at,
              createdBy: "user" as const,
              creationSource: "web" as const,
            },
          ],
          turnItems: [
            {
              id: TurnItemId.make("fallback:error"),
              threadId,
              runId: run.id,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "failed" as const,
              title: "Usage limit",
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "error" as const,
              failure: {
                class: "usage_limit" as const,
                message: "Limit reached",
                code: "429",
                retryable: true,
              },
            },
          ],
        };
        h.projections.set(threadId, projection);
        yield* agents.reconcile();
        expect(h.calls.at(-1)?.modelSelection).toEqual(fallback);
        expect((yield* store.get(h.fixture.id)).fallbackIndex).toBe(2);
        expect(h.calls.at(-1)?.text).toBe("Check CI");
        const retry = h.calls.at(-1)!;
        h.projections.set(threadId, {
          ...projection,
          runs: [
            {
              ...run,
              id: RunId.make("fallback:retry"),
              modelSelection: fallback,
              userMessageId: retry.messageId,
            },
          ],
        });
        const count = h.calls.length;
        yield* agents.reconcile();
        expect(h.calls).toHaveLength(count);
      }).pipe(Effect.provide(h.layer));
    }),
);
