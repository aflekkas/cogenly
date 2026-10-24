import type { OrchestrationV2ProviderThread, ProviderTurnId } from "@cogenly/contracts";
import * as IdAllocator from "@cogenly/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@cogenly/provider-core/server/ProviderAdapter";
import { isContextOverflow, makeProviderFailure } from "@cogenly/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type FailedTerminal = Extract<Event, { type: "turn.terminal"; status: "failed" }>;

/** Keep one run alive across overflow, native compaction and one retry of its original input. */
export const withAutomaticCompaction = Effect.fn("orchestrationV2.withAutomaticCompaction")(
  function* (
    session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    shouldStart: () => Effect.Effect<boolean>,
  ) {
    const ids = yield* IdAllocator.IdAllocatorV2;
    let request: ProviderAdapter.ProviderAdapterV2TurnInput | undefined;
    let attempted = false;
    let originalFailure: FailedTerminal | undefined;
    let compacting = false;
    let latestThread: OrchestrationV2ProviderThread | undefined;
    let currentProviderTurnId: ProviderTurnId | undefined;
    const failedStart = (
      input: ProviderAdapter.ProviderAdapterV2TurnInput,
      cause: unknown,
    ): FailedTerminal => ({
      type: "turn.terminal",
      driver: session.driver,
      providerThreadId: input.providerThread.id,
      providerTurnId: ids.derive.providerTurn({
        driver: session.driver,
        nativeTurnId: `failed:${input.attemptId}`,
      }),
      runOrdinal: input.runOrdinal,
      failureItemOrdinal: input.providerTurnOrdinal * 100 + 1,
      status: "failed",
      failure: makeProviderFailure({ cause, class: "provider_error" }),
      threadDisposition: "reusable",
    });
    const canRecover = (failure: unknown) =>
      !attempted && session.compactThread !== undefined && isContextOverflow(failure);
    const compact = (input: ProviderAdapter.ProviderAdapterV2TurnInput, failure: FailedTerminal) =>
      Effect.gen(function* () {
        attempted = true;
        compacting = true;
        originalFailure = failure;
        latestThread = input.providerThread;
        // This is the same native operation as /compact, without spending the
        // overflowing handoff allowance before the native context is reduced.
        yield* session.compactThread!(input);
      });
    const restoreOriginalFailure = Effect.fnUntraced(function* () {
      const failure = originalFailure!;
      if (currentProviderTurnId !== undefined)
        return [
          { ...failure, providerTurnId: currentProviderTurnId },
        ] satisfies ReadonlyArray<Event>;
      const now = yield* DateTime.now;
      return [
        {
          type: "provider_turn.updated",
          driver: session.driver,
          threadId: request!.threadId,
          providerTurn: {
            id: failure.providerTurnId,
            providerThreadId: failure.providerThreadId,
            nodeId: request!.rootNodeId,
            runAttemptId: request!.attemptId,
            nativeTurnRef: null,
            ordinal: request!.providerTurnOrdinal,
            status: "failed",
            startedAt: now,
            completedAt: now,
          },
        },
        failure,
      ] satisfies ReadonlyArray<Event>;
    });
    const transform = (events: ProviderAdapter.ProviderAdapterV2SessionRuntime["events"]) =>
      events.pipe(
        Stream.mapEffect(
          (event): Effect.Effect<ReadonlyArray<Event>, ProviderAdapter.ProviderAdapterV2Error> =>
            Effect.gen(function* () {
              if (request === undefined) return [event];
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.runAttemptId === request.attemptId
              ) {
                currentProviderTurnId = event.providerTurn.id;
              }
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.id === request.providerThread.id
              ) {
                latestThread = event.providerThread;
              }
              if (
                compacting &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.runAttemptId === request.attemptId
              ) {
                const usage = event.providerTurn.tokenUsage;
                if (usage?.usedTokens != null)
                  latestThread = {
                    ...(latestThread ?? request.providerThread),
                    contextUsage: {
                      ...(latestThread?.contextUsage ?? request.providerThread.contextUsage),
                      usedTokens: usage.usedTokens,
                      ...(usage.maxTokens == null ? {} : { maxTokens: usage.maxTokens }),
                    },
                  };
              }
              if (event.type === "turn_item.updated" && event.turnItem.runId === request.runId) {
                if (
                  event.turnItem.type === "error" &&
                  (compacting || canRecover(event.turnItem.failure))
                )
                  return [];
                if (
                  compacting &&
                  event.turnItem.type === "compaction" &&
                  event.turnItem.afterTokenCount !== undefined
                )
                  latestThread = {
                    ...(latestThread ?? request.providerThread),
                    contextUsage: {
                      ...(latestThread?.contextUsage ?? request.providerThread.contextUsage),
                      usedTokens: event.turnItem.afterTokenCount,
                    },
                  };
              }
              if (
                event.type !== "turn.terminal" ||
                event.providerThreadId !== request.providerThread.id ||
                event.runOrdinal !== request.runOrdinal
              )
                return [event];
              if (compacting) {
                compacting = false;
                if (event.status === "interrupted" || event.status === "cancelled") return [event];
                if (event.status !== "completed") return yield* restoreOriginalFailure();
                const owned = yield* shouldStart();
                if (!owned) return [];
                const retried = yield* Effect.result(
                  session.startTurn({
                    ...request,
                    providerThread: latestThread ?? request.providerThread,
                  }),
                );
                const now = yield* DateTime.now;
                return [
                  {
                    type: "turn_item.updated",
                    driver: session.driver,
                    turnItem: {
                      id: ids.derive.runSignalTurnItem({
                        runId: request.runId,
                        signal: "context-compaction-retry",
                      }),
                      type: "system_notice",
                      threadId: request.threadId,
                      runId: request.runId,
                      nodeId: request.rootNodeId,
                      providerThreadId: request.providerThread.id,
                      providerTurnId: event.providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: request.providerTurnOrdinal * 100 + 99,
                      status: "completed",
                      title: "Request retried",
                      message: "Retried the request after compacting context.",
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                    },
                  },
                  ...(retried._tag === "Failure"
                    ? [
                        {
                          ...failedStart(request, retried.failure),
                          providerTurnId: event.providerTurnId,
                        },
                      ]
                    : []),
                ];
              }
              if (event.status === "failed" && canRecover(event.failure)) {
                if (!(yield* shouldStart())) return [event];
                const result = yield* Effect.result(compact(request, event));
                if (result._tag === "Failure") {
                  compacting = false;
                  return [event];
                }
                return [];
              }
              return [event];
            }),
        ),
        Stream.flatMap((batch) => Stream.fromIterable(batch)),
        Stream.catch((error) =>
          compacting && originalFailure !== undefined
            ? Stream.fromEffect(restoreOriginalFailure()).pipe(
                Stream.flatMap((batch) => Stream.fromIterable(batch)),
              )
            : Stream.fail(error),
        ),
      );
    return {
      ...session,
      events: transform(session.events),
      ...(session.subscribeEvents === undefined
        ? {}
        : {
            subscribeEvents: session.subscribeEvents.pipe(
              Effect.map((subscription) => ({
                ...subscription,
                events: transform(subscription.events),
              })),
            ),
          }),
      startTurn: (input) =>
        Effect.gen(function* () {
          request = input;
          latestThread = input.providerThread;
          yield* session.startTurn(input).pipe(
            Effect.catch((error) => {
              if (!canRecover(error)) return Effect.fail(error);
              return compact(input, failedStart(input, error)).pipe(
                Effect.catch(() => {
                  compacting = false;
                  return Effect.fail(error);
                }),
              );
            }),
          );
        }),
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  },
);
