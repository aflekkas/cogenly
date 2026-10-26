import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type MachineHealthCheck,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ServerSettings as ServerSettingsDocument,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Agents from "../agents/AgentService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Settings from "../serverSettings.ts";
import { layerIdentity } from "../sync/testkit.ts";
import * as HealthCanary from "./HealthCanary.ts";

// ---------------------------------------------------------------------------
// Outcome classification (pure)
// ---------------------------------------------------------------------------

describe("classifyCanary", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const ms = (iso: string) => DateTime.toEpochMillis(at(iso));
  const task = {
    id: ScheduledTaskId.make("health-canary:machine:one"),
    enabled: true,
    createdAt: "2026-10-24T00:00:00.000Z",
    lastRunAt: "2026-10-24T10:00:00.000Z",
    lastRunStatus: "succeeded" as const,
  };
  const threadId = ThreadId.make("thread:canary");
  const run = (
    overrides: Partial<HealthCanary.CanaryRunObservation> = {},
  ): HealthCanary.CanaryRunObservation => ({
    threadId,
    status: "completed",
    requestedAt: at("2026-10-24T10:00:01.000Z"),
    completedAt: at("2026-10-24T10:00:20.000Z"),
    replied: true,
    ...overrides,
  });
  const classify = (overrides: Partial<HealthCanary.CanaryObservation> = {}) =>
    HealthCanary.classifyCanary({
      settings: { enabled: true, intervalMinutes: 60 },
      task,
      run: run(),
      scheduleProblem: null,
      now: at("2026-10-24T10:30:00.000Z"),
      ...overrides,
    });
  const only = (check: MachineHealthCheck) => {
    expect(check.items).toHaveLength(1);
    return check.items[0]!;
  };

  it("passes a turn that completed with a reply within the deadline", () => {
    const check = classify();
    expect(check).toMatchObject({ id: "canary", status: "ok", summary: "Canary passed" });
    const item = only(check);
    expect(item).toMatchObject({
      key: "canary:run",
      target: { _tag: "thread", threadId },
      fix: null,
    });
    expect(DateTime.toEpochMillis(item.since!)).toBe(ms("2026-10-24T10:00:20.000Z"));
  });

  it("fails provider errors, interruptions and silent turns with a run-now fix", () => {
    for (const [observed, title] of [
      [run({ status: "failed" }), "Canary turn failed"],
      [run({ status: "interrupted" }), "Canary turn was interrupted"],
      [run({ replied: false }), "Canary turn ended without a reply"],
    ] as const) {
      const item = only(classify({ run: observed }));
      expect(item).toMatchObject({
        status: "fail",
        title,
        target: { _tag: "scheduledTask", taskId: task.id },
        fix: "run-now",
      });
    }
  });

  it("fails a dispatch that never reached a turn", () => {
    const item = only(
      classify({
        task: { ...task, lastRunStatus: "failed", lastRunAt: "2026-10-24T11:00:00.000Z" },
        now: at("2026-10-24T11:01:00.000Z"),
      }),
    );
    expect(item).toMatchObject({ status: "fail", title: "Canary couldn't start a turn" });
    expect(DateTime.toEpochMillis(item.since!)).toBe(ms("2026-10-24T11:00:00.000Z"));
  });

  it("reports a running turn as in progress until it misses the deadline", () => {
    const running = run({ status: "running", completedAt: null });
    expect(only(classify({ run: running, now: at("2026-10-24T10:05:00.000Z") }))).toMatchObject({
      status: "ok",
      title: "Canary run in progress",
    });
    const late = only(classify({ run: running, now: at("2026-10-24T10:11:00.000Z") }));
    expect(late).toMatchObject({
      status: "fail",
      title: "Canary turn missed its deadline",
      target: { _tag: "thread", threadId },
      fix: "stop-runs",
    });
    expect(DateTime.toEpochMillis(late.since!)).toBe(ms("2026-10-24T10:10:01.000Z"));
    expect(
      only(classify({ run: run({ completedAt: at("2026-10-24T10:12:00.000Z") }) })),
    ).toMatchObject({ status: "fail", title: "Canary turn was too slow" });
  });

  it("fails when the last success is older than 2.5 intervals", () => {
    // 60-minute interval: stale once 150 minutes pass after 10:00:20.
    expect(only(classify({ now: at("2026-10-24T12:30:00.000Z") })).status).toBe("ok");
    const stale = only(classify({ now: at("2026-10-24T12:31:00.000Z") }));
    expect(stale).toMatchObject({ status: "fail", title: "Canary hasn't passed recently" });
    expect(DateTime.toEpochMillis(stale.since!)).toBe(ms("2026-10-24T12:30:20.000Z"));
    // A canary that never ran goes stale from when it was scheduled.
    expect(
      only(
        classify({
          task: { ...task, lastRunAt: null, lastRunStatus: "never" },
          run: null,
          now: at("2026-10-24T03:00:00.000Z"),
        }),
      ),
    ).toMatchObject({ status: "fail", title: "Canary hasn't run" });
  });

  it("is ok and empty while off, and warns while unscheduled or paused", () => {
    expect(classify({ settings: { enabled: false, intervalMinutes: 60 } })).toEqual({
      id: "canary",
      status: "ok",
      summary: "Canary off",
      items: [],
    });
    expect(
      only(classify({ task: null, run: null, scheduleProblem: "scratch-unavailable" })),
    ).toMatchObject({ status: "warn", title: "Canary can't be scheduled" });
    expect(only(classify({ task: { ...task, enabled: false } }))).toMatchObject({
      status: "warn",
      title: "Canary is paused",
    });
  });
});

// ---------------------------------------------------------------------------
// Service: reconcile and a scheduled run through the real machinery
// ---------------------------------------------------------------------------

const scratchProjectId = ProjectId.make("project:scratch");

/** Test settings whose updates reach `subscribeChanges`, like the real service. */
const layerSettings = Layer.effect(
  Settings.ServerSettingsService,
  Effect.gen(function* () {
    const base = yield* Settings.ServerSettingsService;
    const changes = yield* PubSub.unbounded<ServerSettingsDocument>();
    return Settings.ServerSettingsService.of({
      ...base,
      updateSettings: (patch) =>
        base.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
  }),
).pipe(
  Layer.provide(
    Settings.layerTest({
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      },
    }).pipe(Layer.orDie),
  ),
);

const layerFolders = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "health-canary-" });
    return Layer.mock(Folders.ManagedProjectFolders)({
      scratchRoot: Effect.succeed(Option.some(root)),
      ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
    });
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerThreads = Layer.unwrap(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return Layer.mock(Threads.ThreadManagementService)({
      dispatch: orchestrator.dispatch,
      getThreadRecords: orchestrator.getThreadRecords,
    });
  }),
);

/** Launches the way ThreadLaunchService does for a root-less, worktree-less launch. */
const layerLaunch = Layer.unwrap(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${input.commandId}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath:
              input.workspaceStrategy.type === "existing_worktree"
                ? input.workspaceStrategy.worktreePath
                : null,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          const message = input.initialMessage!;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${input.commandId}:initial-message`),
            threadId,
            messageId: message.messageId ?? MessageId.make(`message:${input.commandId}`),
            ...(message.scheduledTaskId === undefined
              ? {}
              : { scheduledTaskId: message.scheduledTaskId }),
            text: message.text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          return {
            threadId,
            projection: yield* orchestrator.getThreadProjection(threadId),
            resumed: false,
          };
        }).pipe(Effect.orDie),
    });
  }),
);

const makeLayer = (provider: ReturnType<typeof makeControllableProvider>) => {
  // One database instance: the orchestrator's projections, the scheduled
  // tasks and the canary's lookup all read it.
  const database = Sqlite.layerMemory;
  const runtime = layerWithRegistry({ name: "health-canary" }, provider.registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const base = Layer.mergeAll(
    database,
    layerIdentity,
    layerSettings,
    layerFolders,
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeServices.layer,
    layerThreads,
    layerLaunch,
  ).pipe(Layer.provideMerge(runtime));
  const tasks = Tasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Agents.AgentService)({}),
        Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
        Layer.mock(Secrets.SecretRequests)({}),
        Scheduler.layer,
      ),
    ),
    Layer.provideMerge(base),
  );
  return HealthCanary.layer.pipe(Layer.provideMerge(tasks));
};

/** Waits for the scheduled-task list to reach a state; the list re-emits on every change. */
const canaryTasks = (predicate: (tasks: ReadonlyArray<ScheduledTask>) => boolean) =>
  Effect.gen(function* () {
    const service = yield* Tasks.ScheduledTaskService;
    const found = yield* service.subscribeList().pipe(
      Stream.map(({ tasks }) => tasks.filter((task) => HealthCanary.isHealthCanaryTaskId(task.id))),
      Stream.filter(predicate),
      Stream.runHead,
    );
    return Option.getOrElse(found, (): ReadonlyArray<ScheduledTask> => []);
  });

const awaitRunStatus = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  statuses: ReadonlyArray<string>,
) =>
  orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
    Stream.filter(
      (row) => row.event.type === "run.updated" && statuses.includes(row.event.payload.status),
    ),
    Stream.take(1),
    Stream.runDrain,
  );

describe("HealthCanary service", () => {
  it.effect("reconciles one scheduled task from the canary settings", () => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({
        health: { canary: { enabled: true, intervalMinutes: 15 } },
      });
      const [created] = yield* canaryTasks((tasks) => tasks.length === 1);
      expect(created!.id.startsWith("health-canary:test-local-machine:")).toBe(true);
      expect(created).toMatchObject({
        ownerMachine: "test-local-machine",
        title: "Health canary",
        prompt: "Reply with exactly OK.",
        enabled: true,
        schedule: { type: "interval", everyMs: 15 * 60_000 },
        projectId: scratchProjectId,
        threadId: null,
        workspaceStrategy: { type: "existing_worktree" },
        modelSelection: { instanceId: "codex" },
        interactionMode: "default",
      });

      yield* settings.updateSettings({ health: { canary: { intervalMinutes: 30 } } });
      const [updated] = yield* canaryTasks((tasks) =>
        tasks.some(
          (task) => task.schedule.type === "interval" && task.schedule.everyMs === 30 * 60_000,
        ),
      );
      expect(updated!.id).toBe(created!.id);

      yield* settings.updateSettings({ health: { canary: { enabled: false } } });
      yield* canaryTasks((tasks) => tasks.length === 0);

      // The deleted id stays tombstoned for sync, so turning it back on needs a new one.
      yield* settings.updateSettings({ health: { canary: { enabled: true } } });
      const [recreated] = yield* canaryTasks((tasks) => tasks.length === 1);
      expect(recreated!.id).not.toBe(created!.id);
    }).pipe(Effect.provide(makeLayer(provider)));
  });

  it.effect("runs the canary turn through the scheduler and reports its outcome", () => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    provider.setStart((input) =>
      Effect.gen(function* () {
        const turn = yield* provider.begin(input);
        const now = yield* DateTime.now;
        yield* provider.publishFor(input, {
          type: "message.updated",
          driver: ProviderDriverKind.make("codex"),
          message: {
            id: MessageId.make(`reply:${input.runId}`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            createdBy: "agent",
            creationSource: "provider",
            role: "assistant",
            text: "OK",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* provider.finish(input, turn);
      }),
    );
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const canary = yield* HealthCanary.HealthCanary;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* settings.updateSettings({
        health: { canary: { enabled: true, intervalMinutes: 15 } },
      });
      const [task] = yield* canaryTasks((tasks) => tasks.length === 1);
      expect(yield* canary.check).toMatchObject({ status: "ok", summary: "Canary scheduled" });

      // The shared scheduler fires the interval task; nothing else drives it.
      yield* TestClock.adjust("16 minutes");
      const [fired] = yield* canaryTasks(
        ([current]) =>
          current !== undefined &&
          current.lastRunStatus !== "never" &&
          current.lastRunStatus !== "running",
      );
      expect(fired?.lastRunStatus).toBe("succeeded");
      yield* worker.drain();
      const input = provider.turns[0]!;
      expect(input.message).toMatchObject({
        text: "Reply with exactly OK.",
        scheduledTaskId: task!.id,
      });
      expect(input.modelSelection.instanceId).toBe("codex");

      yield* awaitRunStatus(orchestrator, input.threadId, ["waiting", "completed"]);
      yield* worker.drain();
      yield* awaitRunStatus(orchestrator, input.threadId, ["completed"]);

      const check = yield* canary.check;
      expect(check).toMatchObject({ id: "canary", status: "ok", summary: "Canary passed" });
      expect(check.items[0]).toMatchObject({
        key: "canary:run",
        target: { _tag: "thread", threadId: input.threadId },
      });
      // A passed run's thread is archived so canary threads don't pile up.
      expect(
        (yield* orchestrator.getThreadProjection(input.threadId)).thread.archivedAt,
      ).not.toBeNull();
    }).pipe(Effect.provide(makeLayer(provider)));
  });
});
