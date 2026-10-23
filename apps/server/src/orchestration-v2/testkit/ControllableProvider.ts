import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Registry from "../ProviderAdapterRegistry.ts";

/** External provider stand-in; orchestration, persistence and effects remain real. */
export const makeControllableProvider = (capabilities: OrchestrationV2ProviderCapabilities) => {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const turns: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steers: ProviderAdapter.ProviderAdapterV2SteerInput[] = [];
  let queue: Queue.Queue<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  let ordinal = 0;
  const publish = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(queue, event);
  const begin = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      turns.push(input);
      const id = ProviderTurnId.make(`turn:${++ordinal}`);
      yield* publish({
        type: "provider_turn.updated",
        driver,
        threadId: input.threadId,
        providerTurn: {
          id,
          providerThreadId: input.providerThread.id,
          nodeId: input.rootNodeId,
          runAttemptId: input.attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "running",
          startedAt: yield* DateTime.now,
          completedAt: null,
        },
      });
      return id;
    });
  const finish = (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    id: ProviderTurnId,
    failure: OrchestrationV2ProviderFailure | null = null,
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* publish({
        type: "provider_turn.updated",
        driver,
        threadId: input.threadId,
        providerTurn: {
          id,
          providerThreadId: input.providerThread.id,
          nodeId: input.rootNodeId,
          runAttemptId: input.attemptId,
          nativeTurnRef: null,
          ordinal,
          status: failure === null ? "completed" : "failed",
          startedAt: now,
          completedAt: now,
        },
      });
      return yield* publish({
        type: "turn.terminal",
        driver,
        providerThreadId: input.providerThread.id,
        providerTurnId: id,
        runOrdinal: input.runOrdinal,
        threadDisposition: "reusable",
        ...(failure === null
          ? { status: "completed", failure: null }
          : {
              status: "failed",
              failure,
              failureItemOrdinal: ordinal * 100 + 1,
            }),
      });
    });
  let start: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (input) =>
    begin(input).pipe(Effect.asVoid);
  let compact: NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["compactThread"]> = () =>
    Effect.die("Unexpected compaction");
  const registry = Layer.mock(Registry.ProviderAdapterRegistryV2)({
    list: () => Effect.succeed([instanceId]),
    getMetadata: () =>
      Effect.succeed({ driver, continuationKey: "codex", enabled: true, capabilities }),
    get: () =>
      Effect.succeed(
        ProviderAdapter.ProviderAdapterV2.of({
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (request) =>
            Effect.gen(function* () {
              queue = yield* Queue.unbounded<
                ProviderAdapter.ProviderAdapterV2Event,
                ProviderAdapter.ProviderAdapterV2Error
              >();
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: request.providerSessionId,
                providerSession: {
                  id: request.providerSessionId,
                  providerInstanceId: instanceId,
                  driver,
                  status: "ready",
                  cwd: request.runtimePolicy.cwd ?? process.cwd(),
                  model: request.modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(queue),
                ensureThread: (input) =>
                  Effect.succeed({
                    id:
                      input.existingProviderThread?.id ??
                      ProviderThreadId.make(`provider-thread:${input.threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: request.providerSessionId,
                    appThreadId: input.threadId,
                    ownerNodeId: null,
                    nativeThreadRef: {
                      driver,
                      nativeId: `native:${input.threadId}`,
                      strength: "strong",
                    },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (input) => start(input),
                compactThread: (input) => compact(input),
                steerTurn: (input) =>
                  Effect.sync(() => {
                    steers.push(input);
                  }),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("Unexpected snapshot"),
                rollbackThread: () => Effect.die("Unexpected rollback"),
                forkThread: () => Effect.die("Unexpected fork"),
              } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
            }),
        }),
      ),
  });
  return {
    registry,
    turns,
    steers,
    begin,
    finish,
    publish,
    failEvents: (error: ProviderAdapter.ProviderAdapterV2Error) => Queue.fail(queue, error),
    setStart: (value: typeof start) => {
      start = value;
    },
    setCompact: (value: typeof compact) => {
      compact = value;
    },
  };
};
