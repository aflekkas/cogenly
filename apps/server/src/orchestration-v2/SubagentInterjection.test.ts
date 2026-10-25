import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
} from "@cogenly/contracts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "@cogenly/provider-core/server/subagentProjection";
import { ProviderAdapterTurnStartError } from "@cogenly/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
    const input = provider.turns.findLast((turn) => turn.threadId === childThreadId)!;
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

/**
 * Publishes a provider-native subagent under the parent's running turn. Claude
 * keeps a subagent's conversation in the parent's session; with `codexThread`
 * the subagent runs on a native thread of its own in that session, as Codex's do.
 */
const startNativeSubagent = (
  provider: ReturnType<typeof makeProvider>,
  options: { readonly codexThread?: boolean } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = yield* startParent;
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const now = yield* DateTime.now;
    const taskId = NodeId.make("node:native-task");
    const childThreadId = ThreadId.make("thread:native-child");
    const childRoot = NodeId.make("node:native-child-root");
    // Native work is the parent session's: publish it there even after the
    // child opened a session of its own.
    const publish = (event: Parameters<typeof provider.publish>[0]) => provider.publishOn(0, event);
    const parentProviderThread = parent.providerThreads.find(
      (candidate) => candidate.id === parentRun.providerThreadId,
    )!;
    const childProviderThread: OrchestrationV2ProviderThread | null =
      options.codexThread === true
        ? {
            ...parentProviderThread,
            id: ProviderThreadId.make("provider-thread:native-child"),
            appThreadId: childThreadId,
            nativeThreadRef: { driver, nativeId: "codex-agent-thread", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: { providerThreadId: parentProviderThread.id },
            createdAt: now,
            updatedAt: now,
          }
        : null;
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
      providerThreadId: childProviderThread?.id ?? null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    yield* publish({
      type: "app_thread.created",
      driver,
      appThread: makeSubagentChildThread({
        parentThread: parent.thread,
        childThreadId,
        parentNodeId: taskId,
        activeProviderThreadId: childProviderThread?.id ?? null,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        title: "Explore",
        now,
        createdBy: "agent",
        creationSource: "provider",
      }),
    });
    yield* publish({ type: "subagent.updated", driver, subagent: task });
    yield* publish({ type: "node.updated", driver, node: root });
    if (childProviderThread !== null) {
      yield* publish({
        type: "provider_thread.updated",
        driver,
        providerThread: childProviderThread,
      });
    }
    let replies = 0;
    const reply = (text: string) =>
      Effect.gen(function* () {
        replies += 1;
        const artifacts = makeSubagentConversationArtifacts({
          messageId: MessageId.make(`message:native-reply-${replies}`),
          turnItemId: TurnItemId.make(`item:native-reply-${replies}`),
          threadId: childThreadId,
          rootNodeId: childRoot,
          providerThreadId: childProviderThread?.id ?? null,
          providerTurnId: null,
          nativeItemRef: null,
          role: "assistant",
          text,
          ordinal: replies,
          now: yield* DateTime.now,
        });
        yield* publish({ type: "message.updated", driver, message: artifacts.message });
        yield* publish({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
        yield* awaitStored(
          childThreadId,
          (row) =>
            row.event.type === "turn-item.updated" &&
            row.event.payload.id === artifacts.turnItem.id,
        );
      });
    yield* reply("The config loader lives in src/config.ts");
    let workStartedAt = now;
    const finishNative = Effect.gen(function* () {
      const done = yield* DateTime.now;
      yield* publish({
        type: "subagent.updated",
        driver,
        subagent: {
          ...task,
          status: "completed",
          result: "Native findings",
          startedAt: workStartedAt,
          completedAt: done,
        },
      });
      yield* publish({
        type: "node.updated",
        driver,
        node: { ...root, status: "completed", startedAt: workStartedAt, completedAt: done },
      });
      yield* awaitStored(
        childThreadId,
        (row) =>
          row.event.type === "node.updated" &&
          row.event.payload.id === childRoot &&
          row.event.payload.completedAt !== null &&
          DateTime.toEpochMillis(row.event.payload.completedAt) === DateTime.toEpochMillis(done),
      );
    });
    /** The parent continues the same native agent, as Claude's SendMessage does. */
    const resumeNative = (text: string) =>
      Effect.gen(function* () {
        workStartedAt = yield* DateTime.now;
        yield* publish({
          type: "subagent.updated",
          driver,
          subagent: { ...task, startedAt: workStartedAt },
        });
        yield* publish({
          type: "node.updated",
          driver,
          node: { ...root, startedAt: workStartedAt },
        });
        yield* awaitStored(
          childThreadId,
          (row) =>
            row.event.type === "node.updated" &&
            row.event.payload.id === childRoot &&
            row.event.payload.status === "running" &&
            row.event.payload.startedAt !== null &&
            DateTime.toEpochMillis(row.event.payload.startedAt) ===
              DateTime.toEpochMillis(workStartedAt),
        );
        yield* reply(text);
      });
    return {
      taskId,
      childThreadId,
      childProviderThreadId: childProviderThread?.id ?? null,
      finishNative,
      resumeNative,
    };
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

const childTurns = (provider: ReturnType<typeof makeProvider>, childThreadId: ThreadId) =>
  provider.turns.filter((turn) => turn.threadId === childThreadId);

const runReached =
  (runId: OrchestrationV2Run["id"], status: string) => (row: OrchestrationV2StoredEvent) =>
    row.event.type === "run.updated" &&
    row.event.payload.id === runId &&
    row.event.payload.status === status;

it.effect(
  "the parent continuing a native subagent during the child's own turn holds the child's queue",
  () => {
    // Without steering, a message during the child's own turn queues behind it.
    const provider = makeProvider(false);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const native = yield* startNativeSubagent(provider);
      yield* native.finishNative;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch(userMessage(native.childThreadId, "own", "Check the tests"));
      yield* worker.drain();
      const ownRun = (yield* orchestrator.getThreadProjection(native.childThreadId)).runs[0]!;
      yield* awaitStored(
        native.childThreadId,
        (row) =>
          row.event.type === "provider-turn.updated" &&
          row.event.payload.runAttemptId === ownRun.activeAttemptId,
      );

      // The parent's provider runs its continuation at once; what the app owns waits.
      yield* TestClock.adjust("1 second");
      yield* native.resumeNative("The tests live in test/");
      yield* orchestrator.dispatch(userMessage(native.childThreadId, "next", "Now fix them"));
      const nextRun = (yield* orchestrator.getThreadProjection(native.childThreadId)).runs.find(
        (run) => run.userMessageId === MessageId.make("message:next"),
      )!;
      expect(nextRun.status).toBe("queued");

      yield* finishLatestTurn(provider, native.childThreadId);
      yield* awaitStored(native.childThreadId, runReached(ownRun.id, "completed"));
      expect(childTurns(provider, native.childThreadId)).toHaveLength(1);

      yield* native.finishNative;
      yield* awaitStored(native.childThreadId, runReached(nextRun.id, "starting"));
      yield* worker.drain();
      const next = childTurns(provider, native.childThreadId).at(-1);
      expect(next?.runId).toBe(nextRun.id);
      // The child's own session never saw the parent's continuation, so the
      // turn starts fresh from the whole transcript instead of resuming.
      expect(next?.message.text).toContain("The tests live in test/");
      expect(next?.message.text).toContain("Now fix them");
      const child = yield* orchestrator.getThreadProjection(native.childThreadId);
      expect(child.contextHandoffs.map((handoff) => handoff.targetRunId)).toEqual([
        ownRun.id,
        nextRun.id,
      ]);
    }).pipe(Effect.provide(layer(provider, "subagent-interjection-native-continued")));
  },
);

it.effect("a Codex native subagent's own turns resume the native thread it ran on", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const native = yield* startNativeSubagent(provider, { codexThread: true });
    yield* native.finishNative;

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch(userMessage(native.childThreadId, "own", "Check docs too"));
    yield* worker.drain();
    const first = childTurns(provider, native.childThreadId)[0];
    expect(first?.providerThread.id).toBe(native.childProviderThreadId);
    expect(provider.resumes).toEqual([native.childProviderThreadId]);
    // The native thread holds the conversation, so nothing is seeded.
    expect(first?.message.text).not.toContain("The config loader lives in src/config.ts");
    yield* finishLatestTurn(provider, native.childThreadId);

    // A continuation by the parent ran on that same native thread.
    yield* TestClock.adjust("1 second");
    yield* native.resumeNative("The README is stale");
    yield* native.finishNative;
    yield* orchestrator.dispatch(userMessage(native.childThreadId, "again", "Fix the README"));
    yield* worker.drain();
    const again = childTurns(provider, native.childThreadId);
    expect(again).toHaveLength(2);
    expect(again[1]?.providerThread.id).toBe(native.childProviderThreadId);
    expect(again[1]?.message.text).not.toContain("The README is stale");
    const child = yield* orchestrator.getThreadProjection(native.childThreadId);
    expect(child.contextHandoffs).toEqual([]);
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-codex-resume")));
});

it.effect("a Codex native subagent whose thread cannot resume starts seeded instead", () => {
  const provider = makeProvider(true);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const native = yield* startNativeSubagent(provider, { codexThread: true });
    yield* native.finishNative;
    provider.setResume(({ providerThread }) =>
      Effect.fail(
        new ProviderAdapterTurnStartError({
          driver,
          threadId: native.childThreadId,
          providerThreadId: providerThread.id,
          runId: RunId.make("run:unresumable"),
          cause: "The native thread is gone",
        }),
      ),
    );

    yield* orchestrator.dispatch(userMessage(native.childThreadId, "own", "Check docs too"));
    yield* worker.drain();
    const turn = childTurns(provider, native.childThreadId)[0];
    expect(provider.resumes).toEqual([native.childProviderThreadId]);
    expect(turn?.message.text).toContain("The config loader lives in src/config.ts");
    expect(turn?.message.text).toContain("Check docs too");
    const child = yield* orchestrator.getThreadProjection(native.childThreadId);
    expect(child.contextHandoffs.map((handoff) => handoff.strategy)).toEqual([
      "full_thread_summary",
    ]);
  }).pipe(Effect.provide(layer(provider, "subagent-interjection-codex-fallback")));
});

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a follow-up reopens a parent cohort after %s",
  (type) => {
    const provider = makeProvider(true);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const owner = yield* startParent;
      const childId = yield* delegate(owner);
      yield* finishLatestTurn(provider, childId);
      yield* awaitStored(
        parentThreadId,
        (row) => row.event.type === "subagent.updated" && row.event.payload.status === "completed",
      );
      yield* worker.drain();
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? {
              type,
              commandId: CommandId.make("stop-owner"),
              threadId: parentThreadId,
              runId: owner.id,
            }
          : { type, commandId: CommandId.make("stop-owner"), threadId: parentThreadId },
      );
      yield* worker.drain();
      expect(
        (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === owner.id,
        )?.delegatedCompletion?.disposition,
      ).toBe("stopped");
      yield* orchestrator.dispatch(userMessage(childId, "after-stop", "Try the new approach"));
      yield* worker.drain();
      const followUp = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (task) => task.followUpOf !== undefined,
      )!;
      yield* finishLatestTurn(provider, childId);
      yield* awaitStored(
        parentThreadId,
        (row) =>
          row.event.type === "subagent.updated" &&
          row.event.payload.id === followUp.id &&
          row.event.payload.status === "completed",
      );
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      expect(
        parent.runs.find((run) => run.id === owner.id)?.delegatedCompletion?.delivery?.taskIds,
      ).toContain(followUp.id);
      yield* awaitStored(
        parentThreadId,
        (row) =>
          row.event.type === "message.updated" &&
          row.event.payload.delegatedCompletion?.taskIds.includes(followUp.id) === true,
      );
    }).pipe(Effect.provide(layer(provider, "followup-stopped-owner")));
  },
);
