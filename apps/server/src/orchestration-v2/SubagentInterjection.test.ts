import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";

const parentThreadId = ThreadId.make("thread:parent");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const driver = ProviderDriverKind.make("codex");

const makeProvider = (supportsActiveSteering: boolean) =>
  makeControllableProvider({
    ...CodexProviderCapabilitiesV2,
    turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering },
  });

const awaitStored = (threadId: ThreadId, predicate: (row: OrchestrationV2StoredEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .streamStoredEventsFrom({ afterSequence: 0, threadId })
      .pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);
  });

const runStatus = (status: string) => (row: OrchestrationV2StoredEvent) =>
  row.event.type === "run.updated" && row.event.payload.status === status;

const userMessage = (threadId: ThreadId, id: string, text: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  deliveryIntent: "auto" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** A parent thread whose first turn is running on the provider. */
const startParent = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: parentThreadId,
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
    ...userMessage(parentThreadId, "parent", "Work"),
    deliveryIntent: undefined,
  });
  yield* worker.drain();
  yield* awaitStored(parentThreadId, (row) => row.event.type === "provider-turn.updated");
  return (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
});

/** Delegates an app-owned task and returns the child's thread id once its turn runs. */
const delegate = (parentRun: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Child work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* worker.drain();
    const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!
      .childThreadId!;
    yield* awaitStored(childThreadId, (row) => row.event.type === "provider-turn.updated");
    return childThreadId;
  });

/** Ends the provider turn of the child's latest run and settles that run. */
const finishLatestTurn = (provider: ReturnType<typeof makeProvider>, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const input = provider.turns.filter((turn) => turn.threadId === childThreadId).at(-1)!;
    yield* awaitStored(
      childThreadId,
      (row) =>
        row.event.type === "provider-turn.updated" &&
        row.event.payload.runAttemptId === input.attemptId,
    );
    const turns = (yield* orchestrator.getThreadProjection(childThreadId)).providerTurns;
    yield* provider.finish(input, turns.find((turn) => turn.runAttemptId === input.attemptId)!.id);
    // The run waits on its checkpoint, which the effect worker captures.
    yield* awaitStored(
      childThreadId,
      (row) =>
        row.event.type === "run.updated" &&
        row.event.payload.id === input.runId &&
        row.event.payload.status === "waiting",
    );
    yield* worker.drain();
  });

const layer = (provider: ReturnType<typeof makeProvider>, name: string) =>
  layerWithRegistry({ name }, provider.registry, {
    runEffectWorker: false,
    runContinuationWorker: true,
  });

it.effect("a user steer reaches a running delegated child and stays part of its task", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const childThreadId = yield* delegate(yield* startParent);

    yield* orchestrator.dispatch(userMessage(childThreadId, "interject", "Use the other API"));
    yield* worker.drain();

    expect(provider.steers.map((steer) => steer.message.text)).toEqual(["Use the other API"]);
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    expect(child.runs).toHaveLength(1);
    expect(
      child.messages.find((message) => message.id === MessageId.make("message:interject")),
    ).toMatchObject({ role: "user", createdBy: "user" });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    expect(parent.subagents).toHaveLength(1);
    expect(parent.subagents[0]?.status).toBe("running");
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-steer")));
});

it.effect("a queued user message to a running child holds its task until that run ends", () => {
  const provider = makeProvider(false);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const childThreadId = yield* delegate(yield* startParent);

    yield* orchestrator.dispatch(userMessage(childThreadId, "queued", "Also add tests"));
    const queued = yield* orchestrator.getThreadProjection(childThreadId);
    expect(queued.runs.map((run) => run.status)).toEqual(["running", "queued"]);

    yield* finishLatestTurn(provider, childThreadId);
    yield* awaitStored(childThreadId, runStatus("starting"));
    yield* worker.drain();
    // The queued message is the task's latest work: the result waits for it.
    const midway = yield* orchestrator.getThreadProjection(parentThreadId);
    expect(midway.subagents).toHaveLength(1);
    expect(midway.subagents[0]?.result).toBeNull();

    yield* finishLatestTurn(provider, childThreadId);
    yield* awaitStored(
      parentThreadId,
      (row) => row.event.type === "subagent.updated" && row.event.payload.status === "completed",
    );
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    expect(parent.subagents).toHaveLength(1);
    const resultTransfer = parent.contextTransfers.find(
      (transfer) => transfer.type === "subagent_result",
    );
    expect(resultTransfer?.sourcePoint.runId).toBe(child.runs[1]?.id);
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-queue")));
});

it.effect("a user message to a completed child starts a follow-up the parent hears about", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const childThreadId = yield* delegate(yield* startParent);
    yield* finishLatestTurn(provider, childThreadId);
    yield* awaitStored(
      parentThreadId,
      (row) =>
        row.event.type === "message.updated" && row.event.payload.delegatedCompletion !== undefined,
    );
    yield* worker.drain();
    const reported = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    expect(reported.status).toBe("completed");
    expect(provider.steers).toHaveLength(1);

    yield* orchestrator.dispatch(userMessage(childThreadId, "followup", "Now make it faster"));
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const followUp = parent.subagents.find((task) => task.id !== reported.id);
    expect(followUp).toMatchObject({
      origin: "app_owned",
      followUpOf: reported.id,
      createdBy: "user",
      prompt: "Now make it faster",
      completionWake: "always",
    });
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    expect(child.runs.at(-1)?.delegatedTaskId).toBe(followUp?.id);

    yield* worker.drain();
    yield* finishLatestTurn(provider, childThreadId);
    yield* awaitStored(
      parentThreadId,
      (row) =>
        row.event.type === "message.updated" &&
        row.event.payload.delegatedCompletion?.taskIds.includes(followUp!.id) === true,
    );
    yield* worker.drain();

    const after = yield* orchestrator.getThreadProjection(parentThreadId);
    // The original keeps its own result; the follow-up carries the update.
    expect(after.subagents.find((task) => task.id === reported.id)).toMatchObject({
      status: "completed",
      result: reported.result,
    });
    expect(after.subagents.find((task) => task.id === followUp!.id)?.status).toBe("completed");
    const notice = provider.steers.at(-1)?.message.text ?? "";
    expect(notice).toContain(`task ${followUp!.id}`);
    expect(notice).toContain(`updates the earlier result of ${reported.id}`);
    expect(notice).toContain("The user sent subagent");
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-follow-up")));
});

/** Publishes a provider-native subagent under the parent's running turn. */
const startNativeSubagent = (provider: ReturnType<typeof makeProvider>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = yield* startParent;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const now = yield* DateTime.now;
    const taskId = NodeId.make("node:native-task");
    const childThreadId = ThreadId.make("thread:native-child");
    const childRoot = NodeId.make("node:native-child-root");
    const task: OrchestrationV2Subagent = {
      id: taskId,
      threadId: parentThreadId,
      runId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: parentRun.providerThreadId,
      childThreadId,
      nativeTaskRef: { driver, nativeId: "native-task", strength: "strong" },
      prompt: "Explore the repo",
      title: "Explore",
      model: modelSelection.model,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const root: OrchestrationV2ExecutionNode = {
      id: childRoot,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: childRoot,
      kind: "root_turn",
      status: "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    yield* provider.publish({
      type: "app_thread.created",
      driver,
      appThread: makeSubagentChildThread({
        parentThread: parent.thread,
        childThreadId,
        parentNodeId: taskId,
        activeProviderThreadId: null,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        title: "Explore",
        now,
        createdBy: "agent",
        creationSource: "provider",
      }),
    });
    yield* provider.publish({ type: "subagent.updated", driver, subagent: task });
    yield* provider.publish({ type: "node.updated", driver, node: root });
    const reply = makeSubagentConversationArtifacts({
      messageId: MessageId.make("message:native-reply"),
      turnItemId: TurnItemId.make("item:native-reply"),
      threadId: childThreadId,
      rootNodeId: childRoot,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text: "The config loader lives in src/config.ts",
      ordinal: 1,
      now,
    });
    yield* provider.publish({ type: "message.updated", driver, message: reply.message });
    yield* provider.publish({ type: "turn_item.updated", driver, turnItem: reply.turnItem });
    yield* awaitStored(childThreadId, (row) => row.event.type === "turn-item.updated");
    const finishNative = Effect.gen(function* () {
      const done = yield* DateTime.now;
      yield* provider.publish({
        type: "subagent.updated",
        driver,
        subagent: { ...task, status: "completed", result: "Native findings", completedAt: done },
      });
      yield* provider.publish({
        type: "node.updated",
        driver,
        node: { ...root, status: "completed", completedAt: done },
      });
    });
    return { taskId, childThreadId, finishNative };
  });

it.effect("a message to a running native subagent queues behind it, then follows up", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const native = yield* startNativeSubagent(provider);

    yield* orchestrator.dispatch(userMessage(native.childThreadId, "native", "Check docs too"));
    const queued = yield* orchestrator.getThreadProjection(native.childThreadId);
    expect(queued.runs.map((run) => run.status)).toEqual(["queued"]);
    expect(provider.steers).toHaveLength(0);
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const followUp = parent.subagents.find((task) => task.origin === "app_owned");
    expect(followUp).toMatchObject({
      followUpOf: native.taskId,
      childThreadId: native.childThreadId,
      status: "pending",
      nativeTaskRef: null,
    });

    yield* native.finishNative;
    yield* awaitStored(native.childThreadId, runStatus("starting"));
    yield* worker.drain();
    const started = yield* orchestrator.getThreadProjection(native.childThreadId);
    // The provider kept the native conversation in the parent's session, so
    // the child's own first turn is seeded with that history.
    expect(started.contextHandoffs.map((handoff) => handoff.strategy)).toEqual([
      "full_thread_summary",
    ]);
    const prompt =
      provider.turns.find((turn) => turn.threadId === native.childThreadId)?.message.text ?? "";
    expect(prompt).toContain("The config loader lives in src/config.ts");
    expect(prompt).toContain("Check docs too");

    yield* finishLatestTurn(provider, native.childThreadId);
    yield* awaitStored(
      parentThreadId,
      (row) =>
        row.event.type === "subagent.updated" &&
        row.event.payload.id === followUp!.id &&
        row.event.payload.status === "completed",
    );
    const after = yield* orchestrator.getThreadProjection(parentThreadId);
    expect(after.subagents.find((task) => task.id === native.taskId)?.result).toBe(
      "Native findings",
    );
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-native-running")));
});

it.effect("a message to a finished native subagent starts its follow-up at once", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const native = yield* startNativeSubagent(provider);
    yield* native.finishNative;
    yield* awaitStored(
      native.childThreadId,
      (row) => row.event.type === "node.updated" && row.event.payload.status === "completed",
    );

    yield* orchestrator.dispatch(userMessage(native.childThreadId, "after", "One more thing"));
    const child = yield* orchestrator.getThreadProjection(native.childThreadId);
    expect(child.runs.map((run) => run.status)).toEqual(["starting"]);
    expect(
      child.messages.find((message) => message.id === MessageId.make("message:after")),
    ).toMatchObject({ role: "user", createdBy: "user" });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    expect(parent.subagents.find((task) => task.followUpOf === native.taskId)?.status).toBe(
      "running",
    );
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-native-finished")));
});
