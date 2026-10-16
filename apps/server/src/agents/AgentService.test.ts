import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
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

const makeHarness = Effect.sync(() => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const launches: Launch.ThreadLaunchInput[] = [];
  const posts: Parameters<Events.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
  const jobs = new Map<string, Effect.Effect<void>>();
  const receipts = new Set<string>();
  const fixture = agentFixture();
  const conversation = idleThreadProjection(liveThreadShell(fixture.conversationThreadId));
  projections.set(fixture.conversationThreadId, conversation);
  const calls: Threads.ThreadManagementSendInput[] = [];
  const commands: import("@t3tools/contracts").OrchestrationV2ServerCommand[] = [];
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
    Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
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
    }),
    Layer.mock(Threads.ThreadManagementService)({
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
              attachments: [],
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
      getThreadShell: (id) => Effect.succeed(projections.has(id) ? liveThreadShell(id) : null),
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
  );
  const database = Sqlite.layerMemory;
  const store = Store.layer.pipe(Layer.provide(database));
  const agents = Agents.layer.pipe(Layer.provide(Layer.mergeAll(boundaries, store, database)));
  const schedules = Schedules.layer.pipe(
    Layer.provide(Layer.mergeAll(boundaries, agents, store, database)),
  );
  const layer = Layer.mergeAll(store, agents, schedules, database).pipe(
    Layer.provide(NodeServices.layer),
  );
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
  return { layer, fixture, launches, posts, calls, commands, jobs, triggerInput, projections };
});

describe("agent execution", () => {
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

  it.effect("paused agents dispatch owner texts while their scheduled triggers stay stopped", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agents = yield* Agents.AgentService;
        const schedules = yield* Schedules.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        yield* store.save(h.fixture);
        const { task } = yield* schedules.upsert(h.triggerInput);
        yield* store.save({ ...h.fixture, enabled: false });
        const result = yield* agents.send({
          id: h.fixture.id,
          commandId: CommandId.make("paused:owner"),
          messageId: MessageId.make("paused:owner"),
          text: "Are you there?",
        });
        expect(result.threadId).toBe(h.fixture.conversationThreadId);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]).toMatchObject({
          text: "Are you there?",
          mode: "auto",
          createdBy: "user",
        });
        expect(yield* store.context(result.threadId)).toContain(h.fixture.instructions);
        expect((yield* store.get(h.fixture.id)).enabled).toBe(false);
        expect(yield* agents.trigger(task, "paused:trigger", task.prompt)).toBe(false);
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '1969-12-20T09:00:00.000Z' WHERE task_id = ${task.id}`;
        yield* h.jobs.get("scheduled-tasks")!;
        expect(h.launches).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "owner texts bypass failure backoff and the daily cap without resuming background work",
    () =>
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
          const paused = yield* store.get(h.fixture.id);
          expect(paused.enabled).toBe(false);
          expect(paused.backoffUntil).not.toBeNull();
          yield* agents.send({
            id: paused.id,
            commandId: CommandId.make("auto-paused:owner"),
            messageId: MessageId.make("auto-paused:owner"),
            text: "Hello",
          });
          expect(h.calls).toHaveLength(1);
          expect(h.calls[0]?.threadId).toBe(paused.conversationThreadId);
          expect((yield* store.get(paused.id)).enabled).toBe(false);
          expect(yield* agents.trigger(task, "auto-paused:trigger", task.prompt)).toBe(false);
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
      expect(agents[0]?.enabled).toBe(true);
      const rows = yield* sql<{
        agent_id: string;
      }>`SELECT agent_id FROM scheduled_tasks WHERE task_id IN (${first.task.id}, ${second.task.id})`;
      expect(new Set(rows.map((r) => r.agent_id)).size).toBe(1);
      expect(rows[0]?.agent_id).toBe(agents[0]?.id);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("posts auto-pause after five provider failures and stops dispatching jobs", () =>
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
      expect((yield* store.get(h.fixture.id)).enabled).toBe(false);
      const last = h.posts.at(-1)?.events[0];
      expect(last?.type === "message.updated" && last.payload.text).toContain("Paused after five");
      expect(yield* agents.trigger(task, "after-pause", task.prompt)).toBe(false);
      expect(h.launches).toHaveLength(5);
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
      const {
        name,
        avatar,
        instructions,
        modelSelection,
        runtimeMode,
        projectId,
        enabled,
        dailyRunCap,
      } = h.fixture;
      const input = {
        name,
        avatar,
        instructions,
        modelSelection,
        runtimeMode,
        projectId,
        enabled,
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
