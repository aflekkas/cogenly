import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  RuntimeRequestId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@cogenly/contracts";
import * as EventSink from "./EventSink.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Orchestrator from "./Orchestrator.ts";
import * as Worker from "./EffectWorker.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Notifications from "./InlineCardNotifications.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:inline-card");
const waitFor = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    yield* engine.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
      Stream.filter((row) => predicate(row.event)),
      Stream.take(1),
      Stream.runDrain,
    );
  });
const start = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:test"),
    title: "Inline cards",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* engine.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send"),
    threadId,
    messageId: MessageId.make("message:start"),
    text: "Set up the service",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* worker.drain();
  yield* waitFor((event) => event.type === "provider-turn.updated");
});
const notify = (summary: string) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    return yield* Notifications.InlineCardNotifications.pipe(
      Effect.flatMap((service) => service.answered({ threadId, key: "approval:1", summary })),
      Effect.provide(
        Notifications.layer.pipe(
          Layer.provide(Layer.mock(Threads.ThreadManagementService)({ dispatch: engine.dispatch })),
        ),
      ),
    );
  });
const runtime = (provider: ReturnType<typeof makeControllableProvider>) =>
  layerWithRegistry({ name: "inline-card-notifications" }, provider.registry, {
    runEffectWorker: false,
  });

it.effect.each(["Approval granted", "Approval denied"])(
  "a late %s starts exactly one turn",
  (summary) => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    return Effect.gen(function* () {
      yield* start;
      const engine = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const first = (yield* engine.getThreadProjection(threadId)).runs[0]!;
      const turn = (yield* engine.getThreadProjection(threadId)).providerTurns[0]!;
      yield* provider.finish(provider.turns[0]!, turn.id);
      yield* waitFor(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.id &&
          (event.payload.status === "waiting" || event.payload.status === "completed"),
      );
      yield* worker.drain();
      yield* notify(summary);
      yield* notify(summary);
      yield* worker.drain();
      const projection = yield* engine.getThreadProjection(threadId);
      expect(projection.runs).toHaveLength(2);
      expect(provider.turns).toHaveLength(2);
      expect(
        projection.messages.filter((message) => message.notification?.summary === summary),
      ).toHaveLength(1);
    }).pipe(Effect.provide(runtime(provider)));
  },
);

it.effect("answers steer into a running turn", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    yield* start;
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* notify("Approval granted");
    yield* worker.drain();
    expect((yield* engine.getThreadProjection(threadId)).runs).toHaveLength(1);
    expect(provider.steers).toHaveLength(1);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("Stop holds an answered card's continuation instead of restarting work", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    yield* start;
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* engine.dispatch({ type: "thread.stop", commandId: CommandId.make("stop"), threadId });
    yield* worker.drain();
    yield* notify("Approval denied");
    yield* worker.drain();
    yield* engine.resumeQueuedRuns;
    yield* worker.drain();
    const queued = (yield* engine.getThreadProjection(threadId)).runs.filter(
      (run) => run.status === "queued",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.queueHeld).toBe(true);
    expect(queued[0]?.queueHoldReason).toBe("stopped");
    expect(provider.turns).toHaveLength(1);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("queues an answer when the provider cannot steer without interrupting", () => {
  const provider = makeControllableProvider({
    ...CodexProviderCapabilitiesV2,
    turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
  });
  return Effect.gen(function* () {
    yield* start;
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* notify("Approval granted");
    yield* worker.drain();
    const projection = yield* engine.getThreadProjection(threadId);
    expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(provider.turns).toHaveLength(1);
    expect(provider.steers).toHaveLength(0);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("an existing queue hold also holds an answered card's continuation", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    yield* start;
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const projection = yield* engine.getThreadProjection(threadId);
    const first = projection.runs[0]!;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queue"),
      threadId,
      messageId: MessageId.make("message:queued"),
      text: "Queued work",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* provider.finish(provider.turns[0]!, projection.providerTurns[0]!.id, {
      class: "provider_error",
      message: "Fixture provider failed",
      code: null,
      retryable: null,
    });
    yield* waitFor(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === first.id &&
        (event.payload.status === "waiting" || event.payload.status === "failed"),
    );
    yield* worker.drain();
    yield* waitFor((event) => event.type === "run.updated" && event.payload.queueHeld === true);
    yield* notify("Approval granted");
    yield* worker.drain();
    const queued = (yield* engine.getThreadProjection(threadId)).runs.filter(
      (run) => run.status === "queued",
    );
    expect(queued).toHaveLength(2);
    expect(queued.every((run) => run.queueHeld)).toBe(true);
    expect(provider.turns).toHaveLength(1);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect.each(["accept", "decline"] as const)(
  "a late native tool approval %s delivers once through a new turn",
  (decision) => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    return Effect.gen(function* () {
      yield* start;
      const engine = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const projection = yield* engine.getThreadProjection(threadId);
      const first = projection.runs[0]!;
      yield* provider.finish(provider.turns[0]!, projection.providerTurns[0]!.id);
      yield* waitFor(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.id &&
          (event.payload.status === "waiting" || event.payload.status === "completed"),
      );
      yield* worker.drain();
      const sink = yield* EventSink.EventSinkV2;
      const requestId = RuntimeRequestId.make("request:late-tool");
      const now = yield* DateTime.now;
      yield* sink.write({
        commandId: CommandId.make("fixture:late-tool"),
        events: [
          {
            id: EventId.make("event:late-tool"),
            type: "runtime-request.updated",
            threadId,
            runId: first.id,
            nodeId: first.rootNodeId!,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: first.rootNodeId!,
              providerTurnId: projection.providerTurns[0]!.id,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "not_resumable", reason: "Original turn ended" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const answer = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("answer:late-tool"),
        threadId,
        requestId,
        decision,
      };
      yield* engine.dispatch(answer);
      yield* engine.dispatch(answer);
      yield* worker.drain();
      const after = yield* engine.getThreadProjection(threadId);
      expect(after.runs).toHaveLength(2);
      expect(after.runtimeRequests.find((request) => request.id === requestId)?.status).toBe(
        "resolved",
      );
      expect(
        after.messages.filter((message) =>
          message.notification?.summary.includes(decision === "decline" ? "denied" : "granted"),
        ),
      ).toHaveLength(1);
      expect(provider.turns).toHaveLength(2);
    }).pipe(Effect.provide(runtime(provider)));
  },
);

it.effect(
  "a private card survives its run and re-awaiting it cannot replace its vault target",
  () => {
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    return Effect.gen(function* () {
      yield* start;
      const engine = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const projection = yield* engine.getThreadProjection(threadId);
      const first = projection.runs[0]!;
      const card = {
        type: "secret_request.record" as const,
        commandId: CommandId.make("private:ask"),
        threadId,
        runId: first.id,
        nodeId: first.rootNodeId!,
        turnItemId: TurnItemId.make("turn-item:private-card"),
        label: "Client secret",
        reason: "Finish setup",
        secretStatus: "pending" as const,
        secretVault: { name: "original-client", type: "api_key" as const },
      };
      yield* engine.dispatch(card);
      yield* provider.finish(provider.turns[0]!, projection.providerTurns[0]!.id);
      yield* waitFor(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.id &&
          (event.payload.status === "waiting" || event.payload.status === "completed"),
      );
      yield* worker.drain();
      yield* notify("Resume setup");
      yield* worker.drain();
      const after = yield* engine.getThreadProjection(threadId);
      const next = after.runs.find((run) => run.id !== first.id)!;
      yield* engine.dispatch({
        ...card,
        commandId: CommandId.make("private:retry"),
        runId: next.id,
        nodeId: next.rootNodeId!,
        secretVault: { name: "replacement-client", type: "api_key" },
      });
      const item = (yield* engine.getThreadProjection(threadId)).turnItems.find(
        (item) => item.id === card.turnItemId,
      );
      expect(item?.type === "secret_request" && item.secretStatus === "pending").toBe(true);
      expect(item?.type === "secret_request" && item.secretVault?.name).toBe("original-client");
      expect(item?.runId).toBe(first.id);
    }).pipe(Effect.provide(runtime(provider)));
  },
);
