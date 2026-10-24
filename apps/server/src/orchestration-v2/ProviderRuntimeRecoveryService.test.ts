import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";

const stores = Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const events = EventSink.layer.pipe(Layer.provideMerge(stores));
const runtime = Recovery.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      events,
      IdAllocator.layer,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("startup keeps the turn start it queues for a continuation a second restart cut", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
    const at = yield* DateTime.now;
    const threadId = ThreadId.make("thread:twice-restarted");
    const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
    const attemptId = RunAttemptId.make("attempt:continuation");
    // The first restart's continuation: dispatched, but cut before its turn began.
    const continuation: OrchestrationV2Run = {
      id: RunId.make("run:continuation"),
      threadId,
      ordinal: 2,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:restart-continuation:run:cut"),
      rootNodeId: NodeId.make("node:continuation"),
      activeAttemptId: attemptId,
      status: "starting",
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      restartContinuationOfRunId: RunId.make("run:cut"),
    };
    yield* sink.writeWithEffects({
      commandId: CommandId.make("command:restart-continuation:run:cut"),
      events: [
        {
          id: EventId.make("event:create-twice"),
          type: "thread.created",
          threadId,
          occurredAt: at,
          payload: thread,
        },
        {
          id: EventId.make("event:continuation"),
          type: "run.updated",
          threadId,
          runId: continuation.id,
          occurredAt: at,
          payload: continuation,
        },
      ],
      // The previous process's start for it, which the restart cancels.
      effects: [
        {
          id: "effect:old-start",
          commandId: CommandId.make("command:restart-continuation:run:cut"),
          threadId,
          request: { type: "provider-turn.start", runId: continuation.id },
        },
      ],
    });

    yield* recovery.recover;

    // Without a live start the run would stay `starting`, a delegated task
    // "running", forever.
    const claimed = yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 60_000 });
    expect(Option.getOrUndefined(claimed)).toMatchObject({
      request: { type: "provider-turn.start", runId: continuation.id },
      commandId: expect.stringContaining("command:restart-revive:startup:"),
    });
    expect(Option.getOrUndefined(yield* outbox.get("effect:old-start"))?.status).toBe("cancelled");
  }).pipe(Effect.provide(runtime)),
);

it.effect.each(["starting", "running", "queued"] as const)(
  "startup fails an interrupted agent %s run with a persisted restart reason, once",
  (status) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
      const at = yield* DateTime.now;
      const threadId = ThreadId.make("thread:interrupted-agent");
      const providerThreadId = ProviderThreadId.make("provider-thread:interrupted");
      const nodeId = NodeId.make("node:interrupted");
      const attemptId = RunAttemptId.make("attempt:interrupted");
      const turnId = ProviderTurnId.make("turn:interrupted");
      const thread = {
        ...idleThreadProjection(liveThreadShell(threadId)).thread,
        agent: { id: AgentId.make("agent:test"), role: "work" as const },
      };
      const run: OrchestrationV2Run = {
        id: RunId.make("run:interrupted-agent"),
        threadId,
        ordinal: 1,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:job"),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status,
        requestedAt: at,
        startedAt: status === "running" ? at : null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:create-agent-work"),
            type: "thread.created",
            threadId,
            occurredAt: at,
            payload: thread,
          },
          {
            id: EventId.make("event:start-agent-work"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: at,
            payload: run,
          },
          {
            id: EventId.make("event:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: at,
            payload: {
              id: providerThreadId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: thread.providerInstanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: at,
              updatedAt: at,
            },
          },
          {
            id: EventId.make("event:attempt"),
            type: "run-attempt.updated",
            threadId,
            runId: run.id,
            occurredAt: at,
            payload: {
              id: attemptId,
              runId: run.id,
              attemptOrdinal: 1,
              rootNodeId: nodeId,
              providerInstanceId: thread.providerInstanceId,
              providerThreadId,
              providerTurnId: turnId,
              reason: "initial",
              status: "running",
              startedAt: at,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:provider-turn"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: at,
            payload: {
              id: turnId,
              providerThreadId,
              nodeId,
              runAttemptId: attemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: at,
              completedAt: null,
            },
          },
        ],
      });
      expect((yield* recovery.recover).terminalizedRuns).toBe(1);
      const records = yield* projections.getThreadRecords(threadId, [
        "runs",
        "turnItems",
        "attempts",
        "providerTurns",
      ]);
      expect(records.runs[0]).toMatchObject({ status: "failed", completedAt: at });
      expect(records.attempts[0]).toMatchObject({ status: "cancelled", completedAt: at });
      expect(records.providerTurns[0]).toMatchObject({ status: "cancelled", completedAt: at });
      expect(records.turnItems).toEqual([
        expect.objectContaining({
          type: "error",
          failure: expect.objectContaining({
            code: "server_restarted",
            message: "Cogenly restarted during this run.",
          }),
        }),
      ]);
      expect((yield* recovery.recover).terminalizedRuns).toBe(0);
      expect((yield* projections.getThreadRecords(threadId, ["turnItems"])).turnItems).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(runtime)),
);
