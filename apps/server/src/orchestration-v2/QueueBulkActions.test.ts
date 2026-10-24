import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:queue-bulk");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const QUEUED = [
  ["one", "First"],
  ["two", "Second"],
  ["three", "Third"],
] as const;
const COMBINED = "First\n\nSecond\n\nThird";

const noSteering: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  turns: {
    ...CodexProviderCapabilitiesV2.turns,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
  },
};

const send = (
  key: string,
  text: string,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`send:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text,
  attachments: [],
  dispatchMode,
  createdBy: "user",
  creationSource: "web",
});

const bulk = (
  type: "queue.clear" | "queue.send-all",
  key: string = type,
): OrchestrationV2Command => ({
  type,
  commandId: CommandId.make(`${key}:command`),
  threadId,
});

/** Waits for the persisted event the next step depends on. */
const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
      Stream.filter((row) => predicate(row.event)),
      Stream.take(1),
      Stream.runDrain,
    );
  });

const queuedRunFor = (key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.find((run) => run.userMessageId === MessageId.make(`message:${key}`))!;
  });

/** A thread whose first turn is running with three messages queued behind it. */
const busyThreadWithQueue = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:test"),
    title: "Queue",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch(send("busy", "Busy", { type: "start_immediately" }));
  yield* worker.drain();
  yield* awaitEvent((event) => event.type === "provider-turn.updated");
  for (const [key, text] of QUEUED) {
    yield* orchestrator.dispatch(send(key, text, { type: "queue_after_active" }));
  }
  return (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
});

/** Fails the running turn so the provider failure holds the queue behind it. */
const failIntoHeldQueue = (provider: ReturnType<typeof makeControllableProvider>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const busy = yield* busyThreadWithQueue;
    const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
    yield* provider.finish(provider.turns[0]!, turn.id, {
      class: "provider_error",
      message: "Provider failed",
      code: null,
      retryable: null,
    });
    yield* awaitEvent(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === busy.id &&
        (event.payload.status === "waiting" || event.payload.status === "failed"),
    );
    yield* worker.drain();
    yield* awaitEvent((event) => event.type === "run.updated" && event.payload.queueHeld === true);
    return busy;
  });

const runtime = (provider: ReturnType<typeof makeControllableProvider>) =>
  layerWithRegistry({ name: "queue-bulk-actions" }, provider.registry, {
    runEffectWorker: false,
  });

it.effect("rejects clearing or sending an empty queue", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* busyThreadWithQueue;
    yield* orchestrator.dispatch(bulk("queue.clear", "first-clear"));
    const clear = yield* orchestrator.dispatch(bulk("queue.clear")).pipe(Effect.flip);
    const sendAll = yield* orchestrator.dispatch(bulk("queue.send-all")).pipe(Effect.flip);
    expect(clear._tag).toBe("OrchestratorDispatchError");
    expect(sendAll._tag).toBe("OrchestratorDispatchError");
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("steers every queued message into the running turn as one message", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const busy = yield* busyThreadWithQueue;
    yield* orchestrator.dispatch(bulk("queue.send-all"));
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(0);
    expect(projection.runs.find((run) => run.id === busy.id)?.status).toBe("running");
    expect(provider.steers).toHaveLength(1);
    expect(provider.steers[0]?.message.text).toContain(COMBINED);
    const steered = projection.messages.find(
      (message) => message.id === MessageId.make("message:one"),
    );
    expect(steered?.runId).toBe(busy.id);
    expect(steered?.text).toBe(COMBINED);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("queues one combined next turn when the provider cannot steer", () => {
  const provider = makeControllableProvider(noSteering);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const busy = yield* busyThreadWithQueue;
    yield* orchestrator.dispatch(bulk("queue.send-all"));
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const queued = projection.runs.filter((run) => run.status === "queued");
    expect(queued.map((run) => run.userMessageId)).toEqual([MessageId.make("message:one")]);
    expect((yield* queuedRunFor("two")).status).toBe("cancelled");
    expect((yield* queuedRunFor("three")).status).toBe("cancelled");
    expect(
      projection.messages.find((message) => message.id === MessageId.make("message:one"))?.text,
    ).toBe(COMBINED);
    expect(projection.runs.find((run) => run.id === busy.id)?.status).toBe("running");
    expect(provider.steers).toHaveLength(0);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("releases a held queue and starts the combined message on an idle thread", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* failIntoHeldQueue(provider);
    yield* orchestrator.dispatch(bulk("queue.send-all"));
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(0);
    expect(projection.runs.some((run) => run.queueHeld === true && run.status === "queued")).toBe(
      false,
    );
    expect((yield* queuedRunFor("one")).status).not.toBe("cancelled");
    expect((yield* queuedRunFor("two")).status).toBe("cancelled");
    expect(provider.turns).toHaveLength(2);
    expect(provider.turns[1]?.message.text).toContain(COMBINED);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("clears a held queue without starting anything", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    yield* failIntoHeldQueue(provider);
    yield* orchestrator.dispatch(bulk("queue.clear"));
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.runs.filter((run) => run.status === "queued")).toHaveLength(0);
    for (const [key] of QUEUED) {
      expect((yield* queuedRunFor(key)).status).toBe("cancelled");
    }
    expect(provider.turns).toHaveLength(1);
  }).pipe(Effect.provide(runtime(provider)));
});
