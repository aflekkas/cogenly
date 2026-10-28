import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";

const driver = ProviderDriverKind.make("codex");
const rootAppThread = (id: ThreadId) =>
  ({
    id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  }) as OrchestrationV2AppThread;

it.effect.each([
  { status: "completed", failure: "later-stream", interrupt: "succeeds" },
  { status: "failed", failure: "later-stream", interrupt: "succeeds" },
  { status: "completed", failure: "terminal-ingest", interrupt: "succeeds" },
  { status: "completed", failure: "terminal-ingest", interrupt: "fails" },
] as const)(
  "stores a $status root provider turn snapshot after a $failure failure only if the interrupt succeeds (it $interrupt)",
  ({ status, failure, interrupt }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const terminalAt = DateTime.subtract(now, { seconds: 1 });
      const key = `terminal-snapshot:${status}:${failure}:${interrupt}`;
      const durableTurns = yield* Ref.make<
        ReadonlyMap<ProviderTurnId, OrchestrationV2ProviderTurn>
      >(new Map());
      const persist = (turn: OrchestrationV2ProviderTurn) =>
        Ref.update(durableTurns, (current) => new Map(current).set(turn.id, turn));
      const interrupts = yield* Ref.make<
        ReadonlyArray<ProviderAdapter.ProviderAdapterV2InterruptInput>
      >([]);
      const ids = backgroundScenarioIds(key);
      const rootTurn = (
        turnStatus: OrchestrationV2ProviderTurn["status"],
        completedAt: DateTime.Utc | null,
      ) => ({
        type: "provider_turn.updated" as const,
        driver,
        providerTurn: {
          id: ids.rootProviderTurnId,
          providerThreadId: ids.providerThreadId,
          nodeId: ids.rootNodeId,
          runAttemptId: ids.attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: turnStatus,
          startedAt: terminalAt,
          completedAt,
        },
      });
      const { observed, finalEvents } = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.make(rootTurn("running", null), rootTurn(status, terminalAt)).pipe(
            Stream.concat(
              failure === "later-stream"
                ? Stream.fail(
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: ProviderSessionId.make(`session:${key}`),
                      cause: "provider process exited",
                    }),
                  )
                : Stream.empty,
            ),
          ),
        ingestNormalized: ({ event }) =>
          event.type !== "provider_turn.updated"
            ? Effect.succeed([])
            : failure === "terminal-ingest" && event.providerTurn.status !== "running"
              ? Effect.fail(
                  new ProviderEventIngestor.ProviderEventPublishError({
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    eventCount: 1,
                    cause: new Error("SQLITE_FULL: database or disk is full"),
                  }),
                )
              : persist(event.providerTurn).pipe(Effect.as([])),
        interruptTurn: (input) =>
          Ref.update(interrupts, (current) => [...current, input]).pipe(
            Effect.andThen(
              interrupt === "fails"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: input.providerTurnId,
                      cause: "provider already exited",
                    }),
                  )
                : Effect.void,
            ),
          ),
        beforeTerminalWrite: (request) =>
          Effect.forEach(request.events, (event) =>
            event.type === "provider-turn.updated" ? persist(event.payload) : Effect.void,
          ).pipe(Effect.as(true)),
      });
      const calls = yield* Ref.get(interrupts);
      assert.equal(calls.length, 1);
      assert.isTrue(calls[0]?.requestRuntimeRestart);
      assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
      assert.isTrue(finalEvents.some((event) => event.type === "run.updated"));
      const durable = (yield* Ref.get(durableTurns)).get(ids.rootProviderTurnId);
      // A failed interrupt keeps the stored turn running for the next start to retry.
      assert.equal(durable?.status, interrupt === "fails" ? "running" : status);
      assert.deepEqual(durable?.completedAt, interrupt === "fails" ? null : terminalAt);
    }),
);

function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly rejectTerminalWrite?: boolean;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly startTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"];
  readonly interruptTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"];
  readonly initialProviderTurnId?: ProviderTurnId | null;
  readonly onStartFailure?: (
    error: RunExecutionService.RunExecutionServiceV2Error,
  ) => Effect.Effect<void>;
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly onSubscriptionClose?: Effect.Effect<void>;
  readonly shouldStartProviderTurn?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["shouldStartProviderTurn"];
  readonly appContext?: ReturnType<McpAppModelContext.McpAppModelContext["Service"]["forThread"]>;
  readonly ingestNormalized?: ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"];
  readonly beforeTerminalWrite?: (
    request: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0],
  ) => Effect.Effect<boolean, EventSink.EventSinkV2Error>;
  readonly afterStart?: (closed: Deferred.Deferred<void>) => Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const submittedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const committedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(finalEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          }
        }
      });
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () => input.appContext ?? Effect.succeed([]),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              Effect.gen(function* () {
                yield* Ref.update(submittedEffects, (current) => [...current, ...payload.effects]);
                yield* Ref.update(committedEffects, (current) => [...current, ...payload.effects]);
                yield* captureFinalEvents(payload.events);
                return [];
              }),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const effects = payload.effects ?? [];
                yield* Ref.update(submittedEffects, (current) => [...current, ...effects]);
                if (
                  input.rejectTerminalWrite === true ||
                  (input.beforeTerminalWrite !== undefined &&
                    !(yield* input.beforeTerminalWrite(payload)))
                ) {
                  return { committed: false, storedEvents: [] };
                }
                yield* Ref.update(committedEffects, (current) => [...current, ...effects]);
                yield* captureFinalEvents(payload.events);
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: input.ingestNormalized ?? (() => Effect.succeed([])),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const start = runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: rootAppThread(ids.threadId),
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events: input.events!(ids),
            close: Deferred.succeed(ingestionDone, undefined).pipe(
              Effect.andThen(input.onSubscriptionClose ?? Effect.void),
            ),
          }),
          startTurn: input.startTurn ?? (() => Effect.void),
          interruptTurn: input.interruptTurn ?? (() => Effect.void),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId:
            input.initialProviderTurnId === undefined
              ? ids.rootProviderTurnId
              : input.initialProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: input.shouldFinalizeRun,
        ...(input.shouldStartProviderTurn === undefined
          ? {}
          : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: "interrupt projection",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
      yield* start.pipe(
        Effect.catch((error) => input.onStartFailure?.(error) ?? Effect.fail(error)),
      );
      yield* input.afterStart?.(ingestionDone) ?? Effect.void;
      yield* Deferred.await(ingestionDone);
    }).pipe(Effect.provide(layerTest));

    return {
      written: yield* Ref.get(writtenItems),
      finalEvents: yield* Ref.get(finalEvents),
      observed: yield* Ref.get(observed),
      submittedEffects: yield* Ref.get(submittedEffects),
      committedEffects: yield* Ref.get(committedEffects),
    };
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}
