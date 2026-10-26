import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const parentId = ThreadId.make("thread:stale-parent");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const reason = "Stopped by machine health: it had stopped responding.";

const waitFor = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  predicate: (row: OrchestrationV2StoredEvent) => boolean,
) =>
  orchestrator
    .streamStoredEventsFrom({ afterSequence: 0, threadId })
    .pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);

it.effect("ends a delegated task no live work will end, and leaves a live one alone", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    layerWithRegistry({ name: "stale-work-settle" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    }),
    ProjectionStore.layer.pipe(Layer.provide(database)),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: parentId,
      projectId: ProjectId.make("project:stale"),
      title: "Master",
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
      text: "Split the work.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* waitFor(orchestrator, parentId, (row) => row.event.type === "provider-turn.updated");
    const parentRun = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate"),
      parentThreadId: parentId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Child work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "server",
    });
    yield* worker.drain();
    const childId = provider.turns.find((turn) => turn.threadId !== parentId)!.threadId;
    yield* waitFor(orchestrator, childId, (row) => row.event.type === "provider-turn.updated");
    const task = () =>
      orchestrator
        .getThreadProjection(parentId)
        .pipe(Effect.map((projection) => projection.subagents[0]!));
    const taskId = (yield* task()).id;
    const settle = (id: string) =>
      orchestrator.dispatch({
        type: "thread.stale-work.settle",
        commandId: CommandId.make(id),
        threadId: parentId,
        subagentIds: [taskId],
        reason,
      });

    // The child is still running: its own Stop ends it, not this.
    yield* settle("settle-live");
    expect((yield* task()).status).toBe("running");

    // The child goes away without its parent hearing (as a lost process or a
    // reconcile can leave it): nothing will ever end the task now.
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:runtime-reconcile:delete-child"),
      threadId: childId,
    });
    expect((yield* task()).status).toBe("running");

    yield* settle("settle-dead");
    expect(yield* task()).toMatchObject({ status: "interrupted", result: reason });
    const parent = yield* orchestrator.getThreadProjection(parentId);
    expect(parent.nodes.find((node) => node.id === parent.subagents[0]!.id)?.status).toBe(
      "interrupted",
    );
  }).pipe(Effect.provide(runtime));
});

it.effect("observes a native subagent's live session without recording runtime activity", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const sessions = yield* Sessions.ProviderSessionManagerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-native"),
      threadId: parentId,
      projectId: ProjectId.make("project:native"),
      title: "Native",
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
      commandId: CommandId.make("send-native"),
      threadId: parentId,
      messageId: MessageId.make("message:native"),
      text: "Work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* waitFor(orchestrator, parentId, (row) => row.event.type === "provider-turn.updated");
    const run = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
    const now = yield* DateTime.now;
    const taskId = NodeId.make("node:native-live");
    yield* provider.publish({
      type: "subagent.updated",
      driver: ProviderDriverKind.make("codex"),
      subagent: {
        id: taskId,
        threadId: parentId,
        runId: run.id,
        parentNodeId: run.rootNodeId!,
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: run.providerThreadId,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Explore",
        title: "Explore",
        model: "gpt-5",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    });
    yield* waitFor(orchestrator, parentId, (row) => row.event.type === "subagent.updated");
    const get = vi
      .spyOn(sessions, "get")
      .mockImplementation(() => Effect.die("planning touched runtime activity"));
    try {
      yield* orchestrator.dispatch({
        type: "thread.stale-work.settle",
        commandId: CommandId.make("observe-native"),
        threadId: parentId,
        subagentIds: [taskId],
        reason,
      });
      expect((yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.status).toBe(
        "running",
      );
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  }).pipe(
    Effect.provide(
      layerWithRegistry({ name: "stale-native-observation" }, provider.registry, {
        runEffectWorker: false,
      }),
    ),
  );
});
