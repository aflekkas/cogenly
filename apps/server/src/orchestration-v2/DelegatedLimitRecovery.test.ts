import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type ServerProvider,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { delegatedTaskStop } from "./DelegatedTaskFailureNotice.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitHandoff from "./UsageLimitHandoff.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
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

const accountA = ProviderInstanceId.make("codex-a");
const accountB = ProviderInstanceId.make("codex-b");

/** A codex account whose five-hour window is `usedPercent` spent, as the usage poller reports it. */
const account = (instanceId: ProviderInstanceId, usedPercent: number, now: DateTime.Utc) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: `${instanceId}@example.com` },
    checkedAt: DateTime.formatIso(now),
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null, isDefault: true },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: DateTime.formatIso(now),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: DateTime.formatIso(DateTime.add(now, { hours: 3 })),
        },
      ],
    },
  }) satisfies ServerProvider;

/**
 * Two accounts of one driver and the real limit-recovery sweep, captured from
 * its scheduler registration so the test runs each tick by hand. Account A is
 * spent; B has headroom.
 */
const setupHandoff = (options?: {
  readonly firstCandidateRefuses?: boolean;
  /** Runs once, mid-sweep, after the sweep read its candidates and before it hands off. */
  readonly midSweep?: (orchestrator: Orchestrator.OrchestratorV2["Service"]) => Effect.Effect<void>;
}) => {
  const accountC = ProviderInstanceId.make("codex-c");
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2, [
    accountA,
    accountB,
    accountC,
  ]);
  let midSweep = options?.midSweep;
  const database = Sqlite.layerMemory;
  const base = Layer.mergeAll(
    database,
    layerWithRegistry({ name: "delegated-limit-handoff" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    }),
    ProjectionStore.layer.pipe(Layer.provide(database)),
  );
  let sweep: Effect.Effect<void> | undefined;
  const scheduler = Layer.succeed(Scheduler.Scheduler, {
    register: (_name, runDueWork) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<Effect.Services<typeof runDueWork>>();
        sweep = runDueWork.pipe(Effect.provideContext(context), Effect.orDie);
      }),
  });
  const threads = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          options?.firstCandidateRefuses &&
          command.type === "message.dispatch" &&
          command.modelSelection?.instanceId === accountB
            ? Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Target refused",
                }),
              )
            : orchestrator.dispatch(command),
        getThreadRecords: (...args) =>
          Effect.suspend(() => {
            const hook = midSweep;
            midSweep = undefined;
            return hook === undefined ? Effect.void : hook(orchestrator);
          }).pipe(Effect.andThen(orchestrator.getThreadRecords(...args))),
        getThreadShell: orchestrator.getThreadShell,
      });
    }),
  );
  const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.map(DateTime.now, (now) => [
      account(accountA, 100, now),
      account(accountB, 20, now),
      ...(options?.firstCandidateRefuses ? [account(accountC, 30, now)] : []),
    ]),
  });
  const settings = ServerSettings.layerTest({ autoResumeLimitedThreads: true }).pipe(Layer.orDie);
  const recovery = UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(UsageLimitHandoff.layer),
    Layer.provideMerge(Layer.mergeAll(threads, registry, settings, scheduler)),
  );
  const runtime = recovery.pipe(Layer.provideMerge(base));
  return {
    provider,
    runtime,
    sweep: Effect.suspend(
      (): Effect.Effect<void> => sweep ?? Effect.die("The recovery sweep was never registered"),
    ),
  };
};

/**
 * A parent on account A delegates a task to a child on A, and A's window runs
 * out under the child: a quota stop, hours from its reset, with the task still
 * waiting on it.
 */
const delegateIntoQuota = (provider: ReturnType<typeof makeControllableProvider>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const onA = { instanceId: accountA, model: "gpt-5" };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId: parentId,
      projectId: ProjectId.make("project:limits"),
      title: "Parent",
      modelSelection: onA,
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
      task: "Audit the billing module",
      modelSelection: onA,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "server",
    });
    yield* worker.drain();
    const childInput = provider.turns.find((turn) => turn.threadId !== parentId)!;
    const childId = childInput.threadId;
    expect(childInput.providerThread.providerInstanceId).toBe(accountA);
    yield* waitFor(orchestrator, childId, (row) => row.event.type === "provider-turn.updated");
    const firstTurn = (yield* orchestrator.getThreadProjection(childId)).providerTurns[0]!;
    const resetAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 3 }));
    yield* provider.finish(childInput, firstTurn.id, {
      class: "usage_limit",
      message: "You've hit your usage limit.",
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
    const failedRun = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
    yield* orchestrator.recoverDelegatedTasks;
    expect((yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.result).toBeNull();
    return { orchestrator, worker, childInput, childId, failedRun };
  });

it.effect(
  "hands a delegated child out of quota to an account with headroom, and its result is the task's",
  () => {
    const { provider, runtime, sweep } = setupHandoff();
    return Effect.gen(function* () {
      const { orchestrator, worker, childInput, childId, failedRun } =
        yield* delegateIntoQuota(provider);

      // The server slept through the stop for days. Its task still waits, so
      // the sweep still decides it: the child moves to B and re-runs the
      // stopped request there.
      yield* TestClock.adjust("2 days");
      yield* sweep;
      const handedOff = yield* orchestrator.getThreadProjection(childId);
      expect(handedOff.thread.modelSelection.instanceId).toBe(accountB);
      const continuation = handedOff.runs.find((run) => run.id !== failedRun.id)!;
      expect(continuation).toMatchObject({
        providerInstanceId: accountB,
        userMessageId: `limit-handoff:${childId}:${failedRun.id}:${accountB}`,
      });
      expect(continuation.delegatedTaskId).toBe(failedRun.delegatedTaskId);
      // The parent hears where its task went, and the task is still running.
      yield* worker.drain();
      const notified = yield* orchestrator.getThreadProjection(parentId);
      expect(
        notified.messages.find((message) =>
          message.id.startsWith("message:delegated-task-recovery:"),
        )?.notification?.delegatedFailures?.[0]?.recovery,
      ).toEqual({ type: "handed_off", providerInstanceId: accountB, model: "gpt-5" });
      expect(notified.subagents[0]!.result).toBeNull();
      // A second tick finds nothing left to recover: no second handoff or resume.
      yield* sweep;
      expect((yield* orchestrator.getThreadProjection(childId)).runs).toHaveLength(2);

      yield* worker.drain();
      const continuationInput = provider.turns.at(-1)!;
      expect(continuationInput).toMatchObject({ threadId: childId, runId: continuation.id });
      expect(continuationInput.providerThread.providerInstanceId).toBe(accountB);
      yield* waitFor(
        orchestrator,
        childId,
        (row) =>
          row.event.type === "provider-turn.updated" &&
          row.event.payload.runAttemptId === continuationInput.attemptId,
      );
      // B starts a fresh native thread seeded with the child's history from A.
      const seeded = yield* orchestrator.getThreadProjection(childId);
      const handoff = seeded.contextHandoffs.find(
        (candidate) => candidate.targetRunId === continuation.id,
      );
      expect(handoff?.fromProviderThreadIds).toContain(childInput.providerThread.id);
      expect(handoff?.toProviderThreadId).toBe(continuationInput.providerThread.id);
      expect(handoff?.summaryText).toContain("Audit the billing module");
      const continuationTurn = seeded.providerTurns.find(
        (turn) => turn.runAttemptId === continuationInput.attemptId,
      )!;

      // B finishes the work; its answer is the task's result.
      const now = yield* DateTime.now;
      yield* provider.publishFor(continuationInput, {
        type: "message.updated",
        driver: ProviderDriverKind.make("codex"),
        message: {
          id: MessageId.make("message:child-answer"),
          threadId: childId,
          runId: continuation.id,
          nodeId: continuationInput.rootNodeId,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: "Billing audit done: two rounding bugs.",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* provider.finish(continuationInput, continuationTurn.id);
      yield* waitFor(
        orchestrator,
        childId,
        (row) =>
          row.event.type === "run.updated" &&
          row.event.payload.id === continuation.id &&
          row.event.payload.status === "waiting",
      );
      yield* worker.drain();
      yield* waitFor(
        orchestrator,
        parentId,
        (row) => row.event.type === "subagent.updated" && row.event.payload.status === "completed",
      );
      const parent = yield* orchestrator.getThreadProjection(parentId);
      expect(parent.subagents[0]).toMatchObject({
        status: "completed",
        result: "Billing audit done: two rounding bugs.",
      });
      expect(
        parent.messages.some((message) => message.id.startsWith("message:delegated-task-failure:")),
      ).toBe(false);
    }).pipe(Effect.provide(runtime));
  },
);

it.effect(
  "a Don't resume that lands mid-sweep is not overwritten by the sweep's stale read",
  () => {
    let childId: ThreadId | undefined;
    let stoppedRunId: string | undefined;
    let resetAt: string | undefined;
    const { provider, runtime, sweep } = setupHandoff({
      midSweep: (orchestrator) =>
        orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("no-resume"),
            threadId: childId!,
            limitRecovery: { runId: stoppedRunId as never, resetAt: resetAt!, autoResume: false },
          })
          .pipe(Effect.orDie, Effect.asVoid),
    });
    return Effect.gen(function* () {
      const stopped = yield* delegateIntoQuota(provider);
      childId = stopped.childId;
      stoppedRunId = stopped.failedRun.id;
      resetAt = (yield* stopped.orchestrator.getThreadShell(stopped.childId))!.usageLimitResetAt!;
      const { orchestrator, worker } = stopped;

      // The sweep read the stop as unrecorded; the choice arrives before it acts.
      yield* sweep;
      const child = yield* orchestrator.getThreadProjection(stopped.childId);
      expect(child.runs).toHaveLength(1);
      expect(child.thread.limitRecovery).toMatchObject({
        autoResume: false,
        requestId: "no-resume",
      });
      // The parent has the limit as its result, and no notice that it moved or will resume.
      yield* worker.drain();
      const parent = yield* orchestrator.getThreadProjection(parentId);
      expect(parent.subagents[0]).toMatchObject({ status: "failed" });
      expect(
        parent.messages.some((message) =>
          message.id.startsWith("message:delegated-task-recovery:"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(runtime));
  },
);

it.effect("the parent's handoff notice survives a stop right after the handoff commits", () => {
  const { provider, runtime } = setupHandoff();
  return Effect.gen(function* () {
    const { orchestrator, worker, childId, failedRun } = yield* delegateIntoQuota(provider);
    // The sweep's handoff commits, then the server stops before it does anything else.
    const identity = `${childId}:${failedRun.id}:${accountB}`;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-handoff:${identity}`),
      messageId: MessageId.make(`limit-handoff:${identity}`),
      threadId: childId,
      manualContinuationOfRunId: failedRun.id,
      modelSelection: { instanceId: accountB, model: "gpt-5" },
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    // Back up, the outbox still owes the parent its notice.
    yield* worker.drain();
    const parent = yield* orchestrator.getThreadProjection(parentId);
    expect(
      parent.messages.find((message) => message.id.startsWith("message:delegated-task-recovery:"))
        ?.notification?.delegatedFailures?.[0]?.recovery,
    ).toEqual({ type: "handed_off", providerInstanceId: accountB, model: "gpt-5" });
  }).pipe(Effect.provide(runtime));
});

it.effect("a Stop on a delegated child still recovering from a limit ends the recovery", () => {
  const { provider, runtime, sweep } = setupHandoff();
  return Effect.gen(function* () {
    const { orchestrator, worker, childId, failedRun } = yield* delegateIntoQuota(provider);

    // task_cancel and a parent's Stop reach the child as this Stop.
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-child"),
      threadId: childId,
    });
    const child = yield* orchestrator.getThreadProjection(childId);
    expect(child.thread.limitRecovery).toMatchObject({ runId: failedRun.id, autoResume: false });
    // The limit is now the task's result, and nothing hands the child off.
    const parent = yield* orchestrator.getThreadProjection(parentId);
    expect(parent.subagents[0]).toMatchObject({ status: "failed" });
    expect(parent.subagents[0]!.result).toContain("usage limit");
    yield* sweep;
    expect((yield* orchestrator.getThreadProjection(childId)).runs).toHaveLength(1);
    // A deliberate Stop owes the parent no failure notice.
    yield* worker.drain();
    expect(
      (yield* orchestrator.getThreadProjection(parentId)).messages.some((message) =>
        message.id.startsWith("message:delegated-task-failure:"),
      ),
    ).toBe(false);
  }).pipe(Effect.provide(runtime));
});

// A refusal restores the scheduled reset before the next candidate is tried.
it.effect("hands off to the second target after the first target refuses", () => {
  const { provider, runtime, sweep } = setupHandoff({ firstCandidateRefuses: true });
  return Effect.gen(function* () {
    const { orchestrator, childId } = yield* delegateIntoQuota(provider);
    yield* sweep;
    expect(
      (yield* orchestrator.getThreadProjection(childId)).thread.modelSelection.instanceId,
    ).toBe("codex-c");
  }).pipe(Effect.provide(runtime));
});

it.effect("releases a delegated child's held messages onto its handoff model", () => {
  const { provider, runtime, sweep } = setupHandoff();
  return Effect.gen(function* () {
    const { orchestrator, worker, childId, failedRun } = yield* delegateIntoQuota(provider);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queued-notice"),
      threadId: childId,
      messageId: MessageId.make("message:held"),
      text: "Check the background result",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    expect((yield* orchestrator.getThreadProjection(childId)).runs.at(-1)?.queueHeld).toBe(true);
    yield* sweep;
    const queued = (yield* orchestrator.getThreadProjection(childId)).runs.find(
      (run) => run.status === "queued",
    )!;
    expect(queued).toMatchObject({
      queueHeld: false,
      providerInstanceId: accountB,
      modelSelection: { instanceId: accountB, model: "gpt-5" },
    });
    yield* worker.drain();
    const input = provider.turns.find(
      (turn) => turn.threadId === childId && turn.runId !== failedRun.id,
    )!;
    yield* waitFor(
      orchestrator,
      childId,
      (row) =>
        row.event.type === "provider-turn.updated" &&
        row.event.payload.runAttemptId === input.attemptId,
    );
    const turn = (yield* orchestrator.getThreadProjection(childId)).providerTurns.find(
      (turn) => turn.runAttemptId === input.attemptId,
    )!;
    yield* provider.finish(input, turn.id);
    yield* waitFor(
      orchestrator,
      childId,
      (row) =>
        row.event.type === "run.updated" &&
        row.event.payload.id === input.runId &&
        row.event.payload.status === "waiting",
    );
    yield* worker.drain();
    expect(
      provider.turns.find((turn) => turn.runId === queued.id)?.providerThread.providerInstanceId,
    ).toBe(accountB);
  }).pipe(Effect.provide(runtime));
});

it.effect("a manual handoff after Don't resume leaves the parent's published result alone", () => {
  const { provider, runtime } = setupHandoff();
  return Effect.gen(function* () {
    const { orchestrator, worker, childId, failedRun } = yield* delegateIntoQuota(provider);
    const resetAt = (yield* orchestrator.getThreadShell(childId))!.usageLimitResetAt!;
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("dont-resume"),
      threadId: childId,
      limitRecovery: { runId: failedRun.id, resetAt, autoResume: false },
    });
    const published = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.result;
    expect(published).not.toBeNull();
    const identity = `${childId}:${failedRun.id}:${accountB}`;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-handoff:${identity}`),
      messageId: MessageId.make(`limit-handoff:${identity}`),
      threadId: childId,
      manualContinuationOfRunId: failedRun.id,
      modelSelection: { instanceId: accountB, model: "gpt-5" },
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    const parent = yield* orchestrator.getThreadProjection(parentId);
    expect(parent.subagents[0]!.result).toBe(published);
    expect(
      parent.messages.some((message) => message.id.startsWith("message:delegated-task-recovery:")),
    ).toBe(false);
  }).pipe(Effect.provide(runtime));
});
