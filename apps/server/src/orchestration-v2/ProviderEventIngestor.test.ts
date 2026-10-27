import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlError from "effect/sql/SqlError";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerTestDatabase = SqlitePersistence.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeLayerTest = <E>(ingestorEventSink: Layer.Layer<EventSink.EventSinkV2, E>) =>
  Layer.mergeAll(
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    layerGit,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerTestStores,
          ingestorEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  );

// EventSink reports a lock that outlasted busy_timeout at BEGIN IMMEDIATE this way.
const lockTimeout = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
});
const constraintFailure = new EventSink.EventSinkWriteError({
  eventCount: 1,
  cause: new SqlError.SqlError({ reason: new SqlError.ConstraintError({ cause: null }) }),
});

/** The ingestor's next sink writes of `events` fail with `errors`, in order; the rest go through. */
const layerFailingWrites = (
  errors: ReadonlyArray<EventSink.EventSinkWriteError>,
  matches: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => boolean = () => true,
) =>
  makeLayerTest(
    Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const pending = [...errors];
        const failNext = <A, R>(
          events: ReadonlyArray<OrchestrationV2DomainEvent>,
          write: Effect.Effect<A, EventSink.EventSinkV2Error, R>,
        ) => Effect.suspend(() => (matches(events) ? (pending.shift() ?? write) : write));
        return EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) => failNext(input.events, eventSink.write(input)),
          writeIfRunCurrent: (input) => failNext(input.events, eventSink.writeIfRunCurrent(input)),
          writeIfProviderThreadOwner: (input) =>
            failNext(input.events, eventSink.writeIfProviderThreadOwner(input)),
        });
      }),
    ).pipe(Layer.provide(layerTestEventSink)),
  );

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  OrchestrationV2DomainEvent,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const ingestCompletedProviderTurn = (
  guard: Pick<
    Parameters<ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"]>[0],
    "writeIfRunCurrent" | "writeIfProviderThreadOwner"
  >,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerTurnId = ProviderTurnId.make("provider-turn:locked");
    const exit = yield* ingestor
      .ingestNormalized({
        providerSessionId: yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
        }),
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
        event: {
          type: "provider_turn.updated",
          driver: CODEX_DRIVER,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: ProviderThreadId.make("provider-thread:locked"),
            nodeId: NodeId.make("node:locked-turn"),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        ...guard,
      })
      .pipe(Effect.exit);
    const projection = yield* projectionStore.getThreadProjection(threadEvent.threadId);
    return { exit, providerTurnId, persisted: projection.providerTurns.map((turn) => turn.id) };
  });

// Neither guard matches a stored run, so a guarded write correctly commits nothing.
const runId = RunId.make("run:locked");
const activeAttemptId = RunAttemptId.make("attempt:locked");
it.effect.each([
  { route: "write", guard: {} },
  {
    route: "writeIfRunCurrent",
    guard: { writeIfRunCurrent: { runId, activeAttemptId, expectedStatus: "running" } },
  },
  {
    route: "writeIfProviderThreadOwner",
    guard: {
      writeIfProviderThreadOwner: {
        providerThreadId: ProviderThreadId.make("provider-thread:locked"),
        runId,
        activeAttemptId,
        expectedLastRunOrdinal: 1,
      },
    },
  },
] as const)("a provider event $route outlasts a brief database lock", ({ route, guard }) =>
  Effect.gen(function* () {
    const { exit, providerTurnId, persisted } = yield* ingestCompletedProviderTurn(guard);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepEqual(persisted, route === "write" ? [providerTurnId] : []);
  }).pipe(Effect.provide(layerFailingWrites([lockTimeout, lockTimeout]))),
);

// The write after the queued errors would succeed, so failing proves the retries stopped.
it.effect.each([
  { failure: "stays locked", errors: [lockTimeout, lockTimeout, lockTimeout] },
  { failure: "fails for another reason", errors: [constraintFailure] },
])("fails a provider event write that $failure", ({ errors }) =>
  Effect.gen(function* () {
    const { exit, persisted } = yield* ingestCompletedProviderTurn({});
    assert.instanceOf(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      ProviderEventIngestor.ProviderEventPublishError,
    );
    assert.isEmpty(persisted);
  }).pipe(Effect.provide(layerFailingWrites(errors))),
);

it.effect("runtime recovery finds live runless provider turns and drops ended ones", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* threadCreatedEvent(now);
    const nodeId = NodeId.make("node:runless-recovery");
    const providerThreadId = ProviderThreadId.make("provider-thread:runless-recovery");
    const providerTurnId = ProviderTurnId.make("provider-turn:runless-recovery");
    yield* sink.write({
      events: [
        thread,
        {
          id: "event:runless-node" as OrchestrationV2DomainEvent["id"],
          type: "node.updated",
          threadId: thread.threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId: thread.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: false,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: "event:runless-turn" as OrchestrationV2DomainEvent["id"],
          type: "provider-turn.updated",
          threadId: thread.threadId,
          occurredAt: now,
          payload: {
            id: providerTurnId,
            providerThreadId,
            nodeId,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    const active = yield* projections.getRuntimeRecoveryProjection(thread.threadId);
    assert.deepEqual(
      active.providerTurns.map((turn) => turn.id),
      [providerTurnId],
    );
    const turn = active.providerTurns[0]!;
    yield* sink.write({
      events: [
        {
          id: "event:runless-ended" as OrchestrationV2DomainEvent["id"],
          type: "provider-turn.updated",
          threadId: thread.threadId,
          occurredAt: now,
          payload: { ...turn, status: "cancelled", completedAt: now },
        },
      ],
    });
    assert.isEmpty(
      (yield* projections.getRuntimeRecoveryProjection(thread.threadId)).providerTurns,
    );
  }).pipe(Effect.provide(makeLayerTest(layerTestEventSink))),
);
