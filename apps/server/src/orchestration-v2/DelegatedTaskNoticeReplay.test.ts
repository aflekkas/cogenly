import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Sink from "./EventSink.ts";
import * as DateTime from "effect/DateTime";
import * as Outbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";

const parentId = ThreadId.make("thread:parent");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const noticePrefix = "message:delegated-task-failure:";
const awaitStored = (threadId: ThreadId, predicate: (row: OrchestrationV2StoredEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .streamStoredEventsFrom({ afterSequence: 0, threadId })
      .pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);
  });

const failChild = (provider: ReturnType<typeof makeControllableProvider>, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId: parentId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "settled_only",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* worker.drain();
    const task = (yield* orchestrator.getThreadProjection(parentId)).subagents.find(
      (candidate) => candidate.prompt === name,
    )!;
    const childId = task.childThreadId!;
    yield* awaitStored(childId, (row) => row.event.type === "provider-turn.updated");
    const input = provider.turns.findLast((turn) => turn.threadId === childId)!;
    const turn = (yield* orchestrator.getThreadProjection(childId)).providerTurns[0]!;
    yield* provider.finish(input, turn.id, {
      class: "provider_error",
      message: "Provider failed",
      code: null,
      retryable: false,
    });
    yield* awaitStored(
      childId,
      (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
    );
    // The terminal event reactor and the recovery sweep share the same parent lock.
    yield* orchestrator.recoverDelegatedTasks;
    yield* worker.drain();
    return { taskId: task.id, childThreadId: childId, childRunId: input.runId };
  });

it.effect("does not fold acknowledged failures into new batches after rebuilding the runtime", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Keep only SQLite alive. Every provider, orchestrator and effect worker is rebuilt.
    const database = Layer.succeed(SqlClient.SqlClient, sql);
    const provider = makeControllableProvider({
      ...CodexProviderCapabilitiesV2,
      turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
    });
    const runtime = () =>
      Layer.mergeAll(
        layerWithRegistry({ name: "task-notice-replay" }, provider.registry, {
          databaseLayer: database,
          runEffectWorker: false,
        }),
        Outbox.layer.pipe(Layer.provide(database)),
      );
    const old = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId: parentId,
        projectId: ProjectId.make("project:test"),
        title: "Parent",
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
        commandId: CommandId.make("send"),
        threadId: parentId,
        messageId: MessageId.make("message:parent"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* awaitStored(parentId, (row) => row.event.type === "provider-turn.updated");
      const old = yield* failChild(provider, "old");
      const before = yield* orchestrator.getThreadProjection(parentId);
      expect(before.messages.filter((message) => message.id.startsWith(noticePrefix))).toHaveLength(
        1,
      );
      // The parent already read the failure through task_status while its notice was queued.
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.acknowledge",
        commandId: CommandId.make("ack:old"),
        parentThreadId: parentId,
        taskId: old.taskId,
        observedByRunId: before.runs[0]!.id,
      });
      return old;
    }).pipe(Effect.provide(runtime()), Effect.scoped);

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.reconcileAfterProcessLoss;
      yield* orchestrator.recoverDelegatedTasks;
      // Replayed committed effects also cannot re-send the old failure.
      yield* outbox.enqueue([
        {
          id: "effect:replayed-old-notice",
          commandId: CommandId.make("replayed-old-notice"),
          threadId: parentId,
          request: { type: "delegated-task.failure-notice", ...old, afterRestart: true },
        },
      ]);
      yield* worker.drain();
      const fresh = yield* failChild(provider, "fresh");
      const parent = yield* orchestrator.getThreadProjection(parentId);
      const notices = parent.messages.filter((message) => message.id.startsWith(noticePrefix));
      expect(notices).toHaveLength(2);
      const freshNotice = notices.find((message) =>
        message.notification?.delegatedFailures?.some((failure) => failure.taskId === fresh.taskId),
      )!;
      const oldNotice = notices.find((message) => message.id !== freshNotice.id)!;
      expect(freshNotice.notification?.delegatedFailures?.map((failure) => failure.taskId)).toEqual(
        [fresh.taskId],
      );
      const sink = yield* Sink.EventSinkV2;
      const now = yield* DateTime.now;
      // Startup reconciliation ended the previous process's foreground parent run.
      yield* sink.writeWithEffects({
        commandId: CommandId.make("end-parent"),
        events: [
          {
            id: EventId.make("event:end-parent"),
            type: "run.updated",
            threadId: parentId,
            runId: parent.runs[0]!.id,
            occurredAt: now,
            payload: { ...parent.runs[0]!, status: "interrupted", completedAt: now },
          },
        ],
        effects: [],
      });
      yield* orchestrator.recoverDelegatedTasks;
      yield* worker.drain();
      const resumed = yield* orchestrator.getThreadProjection(parentId);
      // Admission cancels the acknowledged legacy queue entry before provider work starts.
      expect(resumed.runs.find((run) => run.userMessageId === oldNotice.id)?.status).toBe(
        "cancelled",
      );
      expect(resumed.runs.find((run) => run.userMessageId === freshNotice.id)?.status).not.toBe(
        "queued",
      );
    }).pipe(Effect.provide(runtime()), Effect.scoped);
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
);
