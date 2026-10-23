import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ContextHandoffId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { handoffsAwaitingRun } from "./ContextHandoffDelivery.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";

const stores = Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const runtime = Recovery.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventSink.layer.pipe(Layer.provideMerge(stores)),
      IdAllocator.layer,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const threadId = ThreadId.make("thread:handoff-carry");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const codexThreadId = ProviderThreadId.make("provider-thread:codex");
const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
const switchRunId = RunId.make("run:switch");
const handoffId = ContextHandoffId.make("context-handoff:codex-to-claude");

/**
 * A thread that ran on Codex, then sent its next message to Claude: dispatch
 * moved the thread to Claude's provider thread and prepared the handoff for
 * that run, whose provider turn has not started yet.
 */
const switchedThreadEvents = (
  at: DateTime.Utc,
  switchRunStatus: OrchestrationV2Run["status"],
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const thread = {
    ...idleThreadProjection(liveThreadShell(threadId)).thread,
    providerInstanceId: claude,
    modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
  };
  const run = (
    ordinal: number,
    instanceId: ProviderInstanceId,
    providerThreadId: ProviderThreadId,
    status: OrchestrationV2Run["status"],
  ): OrchestrationV2Run => ({
    id: ordinal === 1 ? RunId.make("run:codex") : switchRunId,
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: instanceId === codex ? "gpt-6.1-sol" : "claude-opus-5-5" },
    providerThreadId,
    userMessageId: MessageId.make(`message:${ordinal}`),
    rootNodeId: NodeId.make(`node:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status,
    requestedAt: at,
    startedAt: status === "completed" ? at : null,
    completedAt: status === "completed" ? at : null,
    checkpointId: null,
    contextHandoffId: ordinal === 1 ? null : handoffId,
  });
  const providerThread = (
    id: ProviderThreadId,
    instanceId: ProviderInstanceId,
    ordinal: number,
  ): OrchestrationV2ProviderThread => ({
    id,
    driver: ProviderDriverKind.make(instanceId),
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: ordinal,
    lastRunOrdinal: ordinal,
    handoffIds: ordinal === 1 ? [] : [handoffId],
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
  });
  const handoff: OrchestrationV2ContextHandoff = {
    id: handoffId,
    threadId,
    targetRunId: switchRunId,
    fromProviderThreadIds: [codexThreadId],
    toProviderThreadId: claudeThreadId,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    status: "ready",
    summaryMessageId: null,
    summaryText: "Earlier Codex conversation.",
    createdByProviderInstanceId: claude,
    createdAt: at,
    updatedAt: at,
  };
  return [
    {
      id: EventId.make("event:thread"),
      type: "thread.created",
      threadId,
      occurredAt: at,
      payload: thread,
    },
    {
      id: EventId.make("event:codex-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: providerThread(codexThreadId, codex, 1),
    },
    {
      id: EventId.make("event:codex-run"),
      type: "run.updated",
      threadId,
      runId: RunId.make("run:codex"),
      occurredAt: at,
      payload: run(1, codex, codexThreadId, "completed"),
    },
    {
      id: EventId.make("event:claude-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: providerThread(claudeThreadId, claude, 2),
    },
    {
      id: EventId.make("event:switch-run"),
      type: "run.updated",
      threadId,
      runId: switchRunId,
      occurredAt: at,
      payload: run(2, claude, claudeThreadId, switchRunStatus),
    },
    {
      id: EventId.make("event:handoff"),
      type: "context-handoff.updated",
      threadId,
      runId: switchRunId,
      occurredAt: at,
      payload: handoff,
    },
  ];
};

// The next send to Claude is not a provider switch any more, so it prepares no
// handoff of its own: it must deliver the one its stopped predecessor carried.
const nextClaudeRun = { id: RunId.make("run:next"), providerThreadId: claudeThreadId };

it.effect(
  "a server restart before the switched run starts keeps its handoff for the next run",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
      const at = yield* DateTime.now;
      yield* sink.write({ events: switchedThreadEvents(at, "starting") });

      expect((yield* recovery.recover).terminalizedRuns).toBe(1);

      const projection = yield* projections.getThreadProjection(threadId);
      expect(projection.thread.activeProviderThreadId).toBe(claudeThreadId);
      expect(projection.runs.find((run) => run.id === switchRunId)?.status).toBe("cancelled");
      expect(handoffsAwaitingRun(projection, nextClaudeRun).map((handoff) => handoff.id)).toEqual([
        handoffId,
      ]);
    }).pipe(Effect.provide(runtime)),
);

it.effect.each(["interrupted", "failed"] as const)(
  "a switched run %s before its provider turn keeps its handoff for the next run",
  (status) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const at = yield* DateTime.now;
      yield* sink.write({ events: switchedThreadEvents(at, status) });

      const projection = yield* projections.getThreadProjection(threadId);
      expect(handoffsAwaitingRun(projection, nextClaudeRun).map((handoff) => handoff.id)).toEqual([
        handoffId,
      ]);
      // Switching back to Codex owes Codex nothing from this handoff.
      expect(
        handoffsAwaitingRun(projection, { id: nextClaudeRun.id, providerThreadId: codexThreadId }),
      ).toEqual([]);
    }).pipe(Effect.provide(runtime)),
);

it.effect("a completed switched run delivered its handoff, so the next run carries none", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const at = yield* DateTime.now;
    yield* sink.write({ events: switchedThreadEvents(at, "completed") });

    const projection = yield* projections.getThreadProjection(threadId);
    expect(handoffsAwaitingRun(projection, nextClaudeRun)).toEqual([]);
    expect(
      handoffsAwaitingRun(projection, { id: switchRunId, providerThreadId: claudeThreadId }).map(
        (handoff) => handoff.id,
      ),
    ).toEqual([handoffId]);
  }).pipe(Effect.provide(runtime)),
);
