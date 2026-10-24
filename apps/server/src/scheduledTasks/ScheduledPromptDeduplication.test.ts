import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
