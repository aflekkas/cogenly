import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { delegatedTaskStop } from "./DelegatedTaskFailureNotice.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { decideLimitStop, limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

/** A fresh fake provider and runtime per test; the effect worker is drained by hand. */
const setup = () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    layerWithRegistry({ name: "delegated-limit-recovery" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    }),
    ProjectionStore.layer.pipe(Layer.provide(database)),
  );
  return { provider, runtime };
};

const parentId = ThreadId.make("thread:parent");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const waitFor = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  predicate: (row: OrchestrationV2StoredEvent) => boolean,
) =>
  orchestrator
    .streamStoredEventsFrom({ afterSequence: 0, threadId })
    .pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);

it.effect(
  "retries a rate-limited delegated child in place, holding its parent's result until it finishes",
  () => {
    const { provider, runtime } = setup();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId: parentId,
        projectId: ProjectId.make("project:limits"),
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
      const childInput = provider.turns.find((turn) => turn.threadId !== parentId)!;
      const childId = childInput.threadId;
      yield* waitFor(orchestrator, childId, (row) => row.event.type === "provider-turn.updated");
      const firstTurn = (yield* orchestrator.getThreadProjection(childId)).providerTurns[0]!;

      // The provider throttles the child: a 429 with a near reset, not a spent quota.
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
      yield* provider.finish(childInput, firstTurn.id, {
        class: "usage_limit",
        message: "Claude API rate limit reached. Try again later.",
        code: "api_error_429",
        retryable: true,
        resetAt,
        limitKind: "rate_limit",
      });
      yield* waitFor(
        orchestrator,
        childId,
        (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
      );
      const failedRun = (yield* orchestrator.getThreadProjection(childId)).runs.find(
        (run) => run.status === "failed",
      )!;
      // Startup-style recovery settles terminal children deterministically: the
      // limit stop is still being recovered, so the parent gets no result yet.
      yield* orchestrator.recoverDelegatedTasks;
      const task = () =>
        orchestrator
          .getThreadProjection(parentId)
          .pipe(Effect.map((projection) => projection.subagents[0]!));
      expect((yield* task()).status).not.toBe("failed");
      expect((yield* task()).result).toBeNull();
      expect(yield* orchestrator.delegatedTaskResultPending(childId, (yield* task()).id)).toBe(
        true,
      );

      // A provider wake arriving now must not start into the limit or hide it.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("wake"),
        threadId: childId,
        messageId: MessageId.make("message:wake"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      const withWake = yield* orchestrator.getThreadProjection(childId);
      const wake = withWake.runs.find((run) => run.userMessageId === "message:wake")!;
      expect(wake).toMatchObject({ status: "queued", queueHeld: true });

      // The sweep's candidate query and decision: retry in place, attempt 1.
      const candidates = yield* projections.getLimitRecoveryCandidates({
        now,
        autoResume: false,
        snooze: false,
      });
      const candidate = candidates.find((thread) => thread.id === childId)!;
      expect(candidate).toMatchObject({
        latestRunId: failedRun.id,
        limitKind: "rate_limit",
        delegated: true,
      });
      const decision = decideLimitStop(candidate);
      expect(decision).toMatchObject({
        type: "arm",
        limitRecovery: { autoResume: true, retryAttempt: 1 },
      });
      if (decision.type !== "arm") return;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("arm"),
        threadId: childId,
        limitRecovery: decision.limitRecovery,
      });
      const armed = yield* orchestrator.getThreadRecords(childId, ["runs", "turnItems"], {
        turnItemTypes: ["error"],
      });
      expect(
        delegatedTaskStop({
          thread: armed.thread,
          runs: armed.runs,
          turnItems: armed.turnItems,
          awaitingRestart: false,
        }),
      ).toEqual({
        stoppedOn: "rate_limit",
        recovery: { type: "retrying", at: resetAt, attempt: 1 },
      });

      // Nothing is due before the backoff; after it, the retry continues the run.
      const due = (at: DateTime.Utc) =>
        projections.getLimitRecoveryCandidates({ now: at, autoResume: false, snooze: false }).pipe(
          Effect.map((rows) => rows.find((thread) => thread.id === childId)),
          Effect.map((thread) =>
            thread === undefined
              ? null
              : limitRecoveryCommand(thread, false, DateTime.toEpochMillis(at)),
          ),
        );
      expect(yield* due(now)).toBeNull();
      yield* TestClock.adjust("2 minutes");
      const retry = yield* due(yield* DateTime.now);
      expect(retry).toMatchObject({
        type: "message.dispatch",
        usageLimitContinuationOfRunId: failedRun.id,
      });
      if (retry?.type !== "message.dispatch") return;
      yield* orchestrator.dispatch(retry);
      const retrying = yield* orchestrator.getThreadProjection(childId);
      const retryRun = retrying.runs.find((run) => run.userMessageId === retry.messageId)!;
      // Same instance, same delegated task; the held wake follows it again.
      expect(retryRun.providerInstanceId).toBe(modelSelection.instanceId);
      // A follow-up task's run names its task; the first one is the child's fork origin.
      expect(retryRun.delegatedTaskId).toBe(failedRun.delegatedTaskId);
      expect(retrying.runs.find((run) => run.id === wake.id)?.queueHeld).toBe(false);

      yield* worker.drain();
      const retryInput = provider.turns.at(-1)!;
      expect(retryInput.threadId).toBe(childId);
      yield* waitFor(
        orchestrator,
        childId,
        (row) =>
          row.event.type === "provider-turn.updated" && row.event.payload.id !== firstTurn.id,
      );
      const retryTurn = (yield* orchestrator.getThreadProjection(childId)).providerTurns.find(
        (turn) => turn.id !== firstTurn.id,
      )!;
      const settle = (runId: string, input: typeof retryInput, turnId: typeof retryTurn.id) =>
        Effect.gen(function* () {
          yield* provider.finish(input, turnId);
          yield* waitFor(
            orchestrator,
            childId,
            (row) =>
              row.event.type === "run.updated" &&
              row.event.payload.id === runId &&
              row.event.payload.status === "waiting",
          );
          yield* worker.drain();
        });
      yield* settle(retryRun.id, retryInput, retryTurn.id);
      // The wake held behind the stop runs after the retry, on the same instance.
      yield* waitFor(
        orchestrator,
        childId,
        (row) =>
          row.event.type === "run.updated" &&
          row.event.payload.id === wake.id &&
          row.event.payload.status !== "queued",
      );
      yield* worker.drain();
      const wakeInput = provider.turns.at(-1)!;
      expect(wakeInput.runId).toBe(wake.id);
      yield* waitFor(
        orchestrator,
        childId,
        (row) =>
          row.event.type === "provider-turn.updated" &&
          row.event.payload.runAttemptId === wakeInput.attemptId,
      );
      const wakeTurn = (yield* orchestrator.getThreadProjection(childId)).providerTurns.find(
        (turn) => turn.runAttemptId === wakeInput.attemptId,
      )!;
      yield* settle(wake.id, wakeInput, wakeTurn.id);
      yield* waitFor(
        orchestrator,
        parentId,
        (row) => row.event.type === "subagent.updated" && row.event.payload.status === "completed",
      );
      // The parent hears the task finished, never that it failed.
      const parent = yield* orchestrator.getThreadProjection(parentId);
      expect(parent.subagents[0]!.status).toBe("completed");
      expect(
        parent.messages.some((message) => message.id.startsWith("message:delegated-task-failure:")),
      ).toBe(false);
    }).pipe(Effect.provide(runtime));
  },
);

it.effect("hands a delegated child's limit to its parent once recovery is turned off", () => {
  const { provider, runtime } = setup();
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: parentId,
      projectId: ProjectId.make("project:limits"),
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
    const childInput = provider.turns.find(
      (turn) => turn.threadId !== parentId && turn.runOrdinal === 1,
    )!;
    const childId = childInput.threadId;
    yield* waitFor(orchestrator, childId, (row) => row.event.type === "provider-turn.updated");
    const turn = (yield* orchestrator.getThreadProjection(childId)).providerTurns[0]!;
    const resetAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 3 }));
    yield* provider.finish(childInput, turn.id, {
      class: "usage_limit",
      message: "You've hit your session limit.",
      code: "usageLimitExceeded",
      retryable: true,
      resetAt,
      limitKind: "quota",
    });
    yield* waitFor(
      orchestrator,
      childId,
      (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
    );
    yield* orchestrator.recoverDelegatedTasks;
    expect((yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.result).toBeNull();

    const failedRun = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("no-resume"),
      threadId: childId,
      limitRecovery: { runId: failedRun.id, resetAt, autoResume: false },
    });
    const parent = yield* orchestrator.getThreadProjection(parentId);
    expect(parent.subagents[0]).toMatchObject({ status: "failed" });
    expect(parent.subagents[0]!.result).toContain("session limit");
  }).pipe(Effect.provide(runtime));
});
