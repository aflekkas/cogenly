import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ThreadRemoteError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as RemoteLaunch from "../orchestration-v2/RemoteThreadLaunch.ts";
import * as NodeAgents from "../agents/AgentService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { layerIdentity } from "../sync/testkit.ts";
import * as Tasks from "./ScheduledTaskService.ts";

it.effect(
  "skips an identical queued scheduled prompt, while allowing changed prompts and other tasks",
  () => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    const database = Sqlite.layerMemory;
    const runtime = layerWithRegistry({ name: "scheduled-prompt-dedup" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:schedule");
      const projectId = ProjectId.make("project:test");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId,
        title: "Scheduled",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("busy"),
        threadId,
        messageId: MessageId.make("message:busy"),
        text: "Busy",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const taskInput = {
        id: ScheduledTaskId.make("task:one"),
        title: "Hourly",
        prompt: "Continue authorized work",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 3600000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" as const },
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      const threads = Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: orchestrator.getThreadRecords,
        sendToThread: (input) =>
          orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: input.commandId,
              threadId: input.threadId,
              messageId: input.messageId,
              scheduledTaskId: input.scheduledTaskId!,
              text: input.text,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.as({} as never)),
      });
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.ScheduledTaskService;
        yield* tasks.upsert(taskInput);
        expect((yield* tasks.runNow({ id: taskInput.id })).task.lastRunStatus).toBe("succeeded");
        expect((yield* tasks.runNow({ id: taskInput.id })).task.lastRunStatus).toBe(
          "skipped_already_queued",
        );
        expect((yield* tasks.list()).tasks[0]?.runCount).toBe(2);
        let projection = yield* orchestrator.getThreadProjection(threadId);
        expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* tasks.upsert({ ...taskInput, prompt: "Changed work" });
        yield* tasks.runNow({ id: taskInput.id });
        yield* tasks.upsert({ ...taskInput, id: ScheduledTaskId.make("task:two") });
        yield* tasks.runNow({ id: ScheduledTaskId.make("task:two") });
        projection = yield* orchestrator.getThreadProjection(threadId);
        expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(3);
        expect(
          projection.messages
            .filter((message) => message.scheduledTaskId === taskInput.id)
            .map((message) => message.text),
        ).toEqual(["Continue authorized work", "Changed work"]);
      }).pipe(
        Effect.provide(
          Tasks.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                database,
                threads,
                layerIdentity,
                Layer.mock(NodeAgents.AgentService)({}),
                Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
                Layer.mock(Launch.ThreadLaunchService)({}),
                Layer.mock(Secrets.SecretRequests)({}),
                Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
                NodeServices.layer,
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(runtime));
  },
);

it.effect(
  "persists a schedule's run target, reports offline runs, and clears the target explicitly",
  () => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    const database = Sqlite.layerMemory;
    const runtime = layerWithRegistry({ name: "scheduled-machine" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    });
    const attempted: Array<Launch.ThreadLaunchInput> = [];
    return Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const machine = EnvironmentId.make("machine:offline");
      const input = {
        id: ScheduledTaskId.make("task:remote"),
        machine,
        title: "Remote check",
        prompt: "Check the repository",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 3600000 },
        projectId: ProjectId.make("project:remote"),
        threadId: null,
        workspaceStrategy: { type: "root" as const },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      expect((yield* tasks.upsert(input)).task.machine).toBe(machine);
      const result = (yield* tasks.runNow({ id: input.id })).task;
      expect(result.lastRunStatus).toBe("failed");
      expect(result.lastRunError).toContain("VPS is offline");
      expect(attempted).toHaveLength(1);
      expect(attempted[0]?.machine).toBe(machine);
      // Omitting the field preserves it; null is the way back to this machine.
      const { machine: _machine, ...withoutMachine } = input;
      yield* tasks.upsert(withoutMachine);
      expect((yield* tasks.list()).tasks[0]?.machine).toBe(machine);
      yield* tasks.upsert({ ...input, machine: null });
      expect((yield* tasks.list()).tasks[0]?.machine).toBeUndefined();
      const invalid = yield* Effect.flip(
        tasks.upsert({ ...input, threadId: ThreadId.make("bound") }),
      );
      expect(invalid.message).toContain("fresh thread");

      // A local replica forwards edits and manual runs to the timer owner,
      // which is distinct from the machine selected to execute each run.
      const sql = yield* SqlClient.SqlClient;
      const remote = yield* RemoteLaunch.RemoteThreadLaunch;
      const owner = EnvironmentId.make("machine:timer-owner");
      yield* sql`UPDATE scheduled_tasks SET owner_machine = ${owner}, run_count = 7 WHERE task_id = ${input.id}`;
      const edits: Array<EnvironmentId> = [];
      const runs: Array<EnvironmentId> = [];
      yield* remote.registerSchedules({
        upsert: (machine, forwarded) =>
          Effect.gen(function* () {
            edits.push(machine);
            // Stand in for the owner's synced row, which upsert must return.
            yield* sql`UPDATE scheduled_tasks SET title = ${forwarded.title}, target_machine = ${forwarded.machine ?? null} WHERE task_id = ${forwarded.id!}`;
            return { task: (yield* tasks.list()).tasks[0]! };
          }).pipe(Effect.orDie),
        run: (machine) => {
          runs.push(machine);
          return Effect.fail(
            new ThreadRemoteError({ reason: "offline", detail: "Timer owner is offline." }),
          );
        },
      });
      const edited = (yield* tasks.upsert({ ...input, title: "Owned elsewhere" })).task;
      expect(edited).toMatchObject({
        ownerMachine: owner,
        machine,
        runCount: 7,
        title: "Owned elsewhere",
      });
      expect(edits).toEqual([owner]);
      expect((yield* Effect.flip(tasks.runNow({ id: input.id }))).message).toContain(
        "Timer owner is offline",
      );
      expect(runs).toEqual([owner]);
      expect(attempted).toHaveLength(1);
      expect((yield* tasks.list()).tasks[0]?.runCount).toBe(7);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Tasks.layer.pipe(
          Layer.provideMerge(RemoteLaunch.layer),
          Layer.provideMerge(database),
          Layer.provide(
            Layer.mergeAll(
              database,
              runtime,
              layerIdentity,
              Layer.mock(Threads.ThreadManagementService)({}),
              Layer.mock(NodeAgents.AgentService)({}),
              Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
              Layer.mock(Launch.ThreadLaunchService)({
                launch: (input) => {
                  attempted.push(input);
                  return Effect.fail(
                    new Launch.ThreadLaunchError({
                      operation: "launch-remote",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: new ThreadRemoteError({
                        reason: "offline",
                        detail: "VPS is offline. Launch on this machine instead.",
                      }),
                    }),
                  );
                },
              }),
              Layer.mock(Secrets.SecretRequests)({}),
              Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  },
);
