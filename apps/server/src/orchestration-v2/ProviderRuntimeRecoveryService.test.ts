import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
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
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";

const stores = Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const events = EventSink.layer.pipe(Layer.provideMerge(stores));
const recoveryRuntime = (continueThreadsAfterServerUpdate: boolean) =>
  Recovery.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        events,
        IdAllocator.layer,
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
const runtime = recoveryRuntime(true);

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

/**
 * A thread whose latest run was cut mid-turn with a live, resumable provider
 * session: everything `restartContinuationRun` needs to resume it.
 */
const seedLiveTurn = (input: {
  readonly threadId: ThreadId;
  readonly agentWork?: boolean;
  /** How many earlier runs form the restart-continuation chain the live run extends. */
  readonly continuationChain?: number;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const at = yield* DateTime.now;
    const earlier = DateTime.subtract(at, { minutes: 5 });
    const { threadId } = input;
    const shell = idleThreadProjection(liveThreadShell(threadId)).thread;
    const thread = input.agentWork
      ? { ...shell, agent: { id: AgentId.make("agent:test"), role: "work" as const } }
      : shell;
    const driver = ProviderDriverKind.make("codex");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const sessionId = ProviderSessionId.make(`session:${threadId}`);
    const chain = Array.from({ length: input.continuationChain ?? 0 }, (_, index) => {
      const id = RunId.make(`run:${threadId}:${index + 1}`);
      const earlierRun: OrchestrationV2Run = {
        id,
        threadId,
        ordinal: index + 1,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${id}`),
        rootNodeId: NodeId.make(`node:${id}`),
        activeAttemptId: RunAttemptId.make(`attempt:${id}`),
        status: "cancelled",
        requestedAt: earlier,
        startedAt: earlier,
        completedAt: earlier,
        checkpointId: null,
        contextHandoffId: null,
        ...(index === 0
          ? {}
          : { restartContinuationOfRunId: RunId.make(`run:${threadId}:${index}`) }),
      };
      return earlierRun;
    });
    const nodeId = NodeId.make(`node:${threadId}:live`);
    const attemptId = RunAttemptId.make(`attempt:${threadId}:live`);
    const turnId = ProviderTurnId.make(`turn:${threadId}:live`);
    const run: OrchestrationV2Run = {
      id: RunId.make(`run:${threadId}:live`),
      threadId,
      ordinal: chain.length + 1,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: thread.modelSelection,
      providerThreadId,
      userMessageId: MessageId.make(`message:${threadId}:live`),
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
      status: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      ...(chain.length === 0 ? {} : { restartContinuationOfRunId: chain.at(-1)!.id }),
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${threadId}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: at,
          payload: thread,
        },
        ...[...chain, run].map((candidate) => ({
          id: EventId.make(`event:${candidate.id}`),
          type: "run.updated" as const,
          threadId,
          runId: candidate.id,
          occurredAt: at,
          payload: candidate,
        })),
        {
          id: EventId.make(`event:${threadId}:session`),
          type: "provider-session.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: at,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            status: "ready",
            cwd: "/tmp/recovery-test",
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: at,
            updatedAt: at,
            lastError: null,
          },
        },
        {
          id: EventId.make(`event:${threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: at,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: thread.providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: run.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          id: EventId.make(`event:${threadId}:attempt`),
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
          id: EventId.make(`event:${threadId}:provider-turn`),
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
    return run;
  });

const recoveredState = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const projections = yield* Projections.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"]);
    return {
      run: records.runs.find((candidate) => candidate.id === runId),
      interrupted: records.turnItems.find((item) => item.id === `server-restarted:${runId}`),
      continuation: Option.getOrUndefined(
        yield* outbox.get(`effect:restart-continuation:${runId}`),
      ),
    };
  });

it.effect.each([
  { kind: "a conversation", agentWork: false },
  { kind: "agent work", agentWork: true },
])("startup schedules a resume for $kind cut mid-turn", ({ agentWork }) =>
  Effect.gen(function* () {
    const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
    const threadId = ThreadId.make(`thread:resume-${agentWork ? "agent" : "chat"}`);
    const run = yield* seedLiveTurn({ threadId, agentWork });
    expect((yield* recovery.recover).terminalizedRuns).toBe(1);
    const state = yield* recoveredState(threadId, run.id);
    // A continuation needs a cancelled source, agent work included.
    expect(state.run).toMatchObject({ status: "cancelled" });
    expect(state.interrupted).toMatchObject({
      type: "error",
      status: "cancelled",
      failure: expect.objectContaining({
        code: "server_restarted",
        message: "Cogenly restarted during this run. Resuming…",
      }),
    });
    expect(state.continuation).toMatchObject({
      status: "pending",
      request: { type: "provider-runtime.continue", sourceRunId: run.id },
    });
    // A second recovery finds nothing left to cut and schedules nothing new.
    expect((yield* recovery.recover).terminalizedRuns).toBe(0);
  }).pipe(Effect.provide(recoveryRuntime(true))),
);

it.effect("startup does not resume a run at the end of a full resume chain", () =>
  Effect.gen(function* () {
    const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
    const threadId = ThreadId.make("thread:resume-chain");
    // Three earlier runs: the live one is the third automatic continuation.
    const run = yield* seedLiveTurn({ threadId, continuationChain: 3 });
    expect((yield* recovery.recover).terminalizedRuns).toBe(1);
    const state = yield* recoveredState(threadId, run.id);
    expect(state.run).toMatchObject({ status: "cancelled" });
    expect(state.interrupted).toMatchObject({
      status: "failed",
      failure: expect.objectContaining({ message: "Cogenly restarted during this run." }),
    });
    expect(state.continuation).toBeUndefined();
  }).pipe(Effect.provide(recoveryRuntime(true))),
);

it.effect("startup keeps the interrupted outcome when resuming is turned off", () =>
  Effect.gen(function* () {
    const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
    const threadId = ThreadId.make("thread:resume-off");
    const run = yield* seedLiveTurn({ threadId });
    expect((yield* recovery.recover).terminalizedRuns).toBe(1);
    const state = yield* recoveredState(threadId, run.id);
    expect(state.run).toMatchObject({ status: "cancelled" });
    expect(state.interrupted).toMatchObject({
      status: "failed",
      failure: expect.objectContaining({ message: "Cogenly restarted during this run." }),
    });
    expect(state.continuation).toBeUndefined();
  }).pipe(Effect.provide(recoveryRuntime(false))),
);
