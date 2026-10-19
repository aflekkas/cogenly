import * as Workspace from "./AgentWorkspaceService.ts";
import * as Policy from "./AgentMcpPolicy.ts";
import {
  AgentScopeLabelId,
  conservativeAgentPermissions,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Schema from "effect/Schema";
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

const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  const workspace = Workspace.layer.pipe(
    Layer.provide(Layer.mergeAll(store, agents, schedules, boundaries, database)),
  );
  const policy = Policy.layer.pipe(
    Layer.provide(Layer.mergeAll(store, workspace, boundaries, database)),
  );
  const layer = Layer.mergeAll(store, agents, schedules, workspace, policy, database).pipe(
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
  it.effect(
    "new agents are conservative, retain mission separately, and paused is the inverse of enabled",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const agents = yield* Agents.AgentService;
          const store = yield* Store.AgentStore;
          const created = (yield* agents.upsert({
            ...h.fixture,
            id: undefined,
            responsibility: "Monitor CI",
            autonomy: undefined,
            permissions: undefined,
            notifyPolicy: undefined,
            paused: true,
          })).agent;
          expect(created).toMatchObject({
            responsibility: "Monitor CI",
            instructions: h.fixture.instructions,
            autonomy: "propose",
            permissions: conservativeAgentPermissions,
            enabled: false,
            paused: true,
          });
          const edited = (yield* agents.upsert({ ...created, paused: false })).agent;
          expect(edited.enabled).toBe(true);
          yield* store.outcome(edited.id, false);
          expect((yield* store.get(edited.id)).paused).toBe(false);
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("an observe agent cannot start Work through either service or MCP policy", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const workspace = yield* Workspace.AgentWorkspaceService;
        const policy = yield* Policy.AgentMcpPolicy;
        const agent = yield* store.save({ ...h.fixture, autonomy: "observe" });
        const actor = { agent, threadId: agent.conversationThreadId };
        expect(
          (yield* Effect.result(
            workspace.startWork(
              {
                agentId: agent.id,
                projectId: agent.projectId!,
                title: "Fix CI",
                prompt: "Repair tests",
              },
              actor,
            ),
          ))._tag,
        ).toBe("Failure");
        const denied = yield* policy
          .beforeTool(
            scopeFor(actor.threadId),
            "t3_thread_launch",
            { title: "Fix CI", message: "Repair tests" },
            false,
          )
          .pipe(Effect.flip);
        expect(denied.code).toBe("agent_permission_denied");
        expect(h.launches).toHaveLength(0);
        expect((yield* workspace.listApprovals({})).approvals).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "propose start-Work produces an approval; approval launches once through the ordinary service",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const workspace = yield* Workspace.AgentWorkspaceService;
          const policy = yield* Policy.AgentMcpPolicy;
          const agent = yield* store.save({
            ...h.fixture,
            autonomy: "propose",
            permissions: conservativeAgentPermissions,
          });
          const denied = yield* policy
            .beforeTool(
              scopeFor(agent.conversationThreadId),
              "t3_thread_launch",
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
            initialMessage: { text: "Repair tests" },
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
            autonomy: "propose",
            permissions: conservativeAgentPermissions,
          });
          const actor = { agent, threadId: agent.conversationThreadId };
          const action = {
            actionKind: "change_permissions" as const,
            payload: { permissions: h.fixture.permissions, autonomy: "execute_bounded" as const },
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

  it.effect(
    "two agents share explicitly granted label commitments, without copying memory or widening access",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Effect.gen(function* () {
          const store = yield* Store.AgentStore;
          const workspace = yield* Workspace.AgentWorkspaceService;
          const label = AgentScopeLabelId.make("spawn");
          const secret = AgentScopeLabelId.make("private");
          const grants = [{ labelId: label, permissions: conservativeAgentPermissions }];
          const a = yield* store.save({ ...h.fixture, autonomy: "propose", scope: grants });
          const b = yield* store.save({ ...agentFixture("engineering"), scope: grants });
          const outsider = yield* store.save({ ...agentFixture("outsider"), scope: [] });
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
          expect(
            (yield* Effect.result(
              workspace.createCommitment(
                { ...input, labelIds: [secret] },
                { agent: a, threadId: a.conversationThreadId },
              ),
            ))._tag,
          ).toBe("Failure");
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
          yield* store.save({ ...b, scope: [] });
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
        yield* store.save({ ...agent, autonomy: "observe" });
        expect(
          (yield* Effect.result(
            workspace.startWork(
              {
                agentId: agent.id,
                projectId: agent.projectId!,
                title: "Stale authority",
                prompt: "Do it",
              },
              actor,
            ),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            policy.beforeTool(scopeFor(actor.threadId), "t3_pending_request_respond", {}, false),
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
          autonomy: "execute_bounded",
          permissions: { ...conservativeAgentPermissions, execute: true },
        });
        const policy = yield* Policy.AgentMcpPolicy;
        for (const name of [
          "send_message",
          "create_pull_request",
          "merge_pull_request",
          "deploy",
          "delete_project",
          "terminal_run",
          "create_threads",
          "delegate_task",
          "t3_thread_configure",
          "t3_pending_request_respond",
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
              "t3_project_read",
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
