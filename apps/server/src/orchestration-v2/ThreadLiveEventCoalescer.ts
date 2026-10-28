import type { OrchestrationV2ThreadStreamItem } from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  LiveStreamBufferError,
  makeLiveStreamBudget,
  type RetainedLiveItem,
} from "./LiveStreamBudget.ts";

const COALESCE_WINDOW = Duration.millis(50);
const MAX_PENDING_UPDATES = 512;

type ThreadLiveEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
export type ThreadLiveInput = ThreadLiveEvent | { readonly kind: "synchronized" };

/**
 * Identity of an in-flight update that a later update of the same entity fully
 * replaces: running tools, and streaming assistant or reasoning text. Final
 * and non-streaming updates return null and always survive.
 */
function coalescibleUpdateKey(input: ThreadLiveEvent): string | null {
  const { event } = input;
  const prefix = `${event.threadId}\u0000${event.runId ?? ""}\u0000${event.type}`;
  if (event.type === "message.updated") {
    return event.payload.role === "assistant" && event.payload.streaming
      ? `${prefix}\u0000${event.payload.id}`
      : null;
  }
  if (event.type !== "turn-item.updated" || event.payload.status !== "running") return null;
  switch (event.payload.type) {
    case "assistant_message":
    case "reasoning":
      if (!event.payload.streaming) return null;
      break;
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
      break;
    default:
      return null;
  }
  return `${prefix}\u0000${event.payload.type}\u0000${event.payload.id}`;
}

/**
 * Drop updates superseded by a later update of the same entity in the batch.
 * Survivors keep their original position and sequence, so a resume cursor at
 * any survivor cannot skip an unrelated earlier update.
 */
export function coalesceLiveUpdatedEvents(
  events: ReadonlyArray<ThreadLiveEvent>,
): ReadonlyArray<ThreadLiveEvent> {
  const latestUpdates = new Map<string, number>();
  const superseded = new Set<number>();
  const pendingKeys = new Map<ThreadLiveEvent["event"]["type"], string>();

  for (const [index, event] of events.entries()) {
    const key = coalescibleUpdateKey(event);
    if (key === null) {
      latestUpdates.clear();
      pendingKeys.clear();
      continue;
    }
    // Messages and turn items are inserted in arrival order, and a partial
    // timeline drops unseen items below its ordinal watermark. Moving an
    // entity's first update past another entity's would reorder or drop it,
    // so an identity switch within a family ends coalescing. A message and
    // its paired turn item still coalesce together.
    const pendingKey = pendingKeys.get(event.event.type);
    if (pendingKey !== undefined && pendingKey !== key) latestUpdates.clear();
    pendingKeys.set(event.event.type, key);
    const previous = latestUpdates.get(key);
    if (previous !== undefined) superseded.add(previous);
    latestUpdates.set(key, index);
  }
  return superseded.size === 0 ? events : events.filter((_, index) => !superseded.has(index));
}

export const makeThreadLiveEventCoalescer = <E = never>(options?: {
  readonly coalesceWindow?: Duration.Input;
  readonly maxItems?: number;
  readonly maxSerializedBytes?: number;
}) =>
  Effect.gen(function* () {
    const coalescerScope = yield* Effect.scope;
    const budget = yield* makeLiveStreamBudget(options);
    const cleanupComplete = yield* Deferred.make<void>();
    const output = yield* Queue.unbounded<
      RetainedLiveItem<ThreadLiveInput>,
      E | LiveStreamBufferError | Cause.Done
    >();
    const mutex = yield* Semaphore.make(1);
    const coalesceWindow = options?.coalesceWindow ?? COALESCE_WINDOW;
    let pendingUpdates: Array<RetainedLiveItem<ThreadLiveEvent>> = [];
    let windowGeneration = 0;
    let windowFiber: Fiber.Fiber<void, never> | null = null;
    let closed = false;

    const cancelWindow = Effect.fn("ThreadLiveEventCoalescer.cancelWindow")(function* () {
      const fiber = windowFiber;
      if (!fiber) {
        return;
      }
      windowFiber = null;
      yield* Fiber.interrupt(fiber);
    });

    const flushPending = Effect.fn("ThreadLiveEventCoalescer.flushPending")(function* () {
      if (pendingUpdates.length === 0) {
        return;
      }
      const items = yield* budget.replace(
        pendingUpdates,
        coalesceLiveUpdatedEvents(pendingUpdates.map((item) => item.value)),
      );
      pendingUpdates = [];
      yield* Queue.offerAll(output, items);
    }, Effect.uninterruptible);

    const flushWindow = (generation: number) =>
      Effect.sleep(coalesceWindow).pipe(
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.suspend(() => (generation === windowGeneration ? flushPending() : Effect.void)),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (generation === windowGeneration) {
              windowFiber = null;
            }
          }),
        ),
        Effect.catchTags({ LiveStreamBufferError: () => Effect.void }),
      );

    // Keep each source batch together so a synchronization marker cannot pass
    // events already pulled from PubSub but still being coalesced.
    const offerAll = Effect.fn("ThreadLiveEventCoalescer.offerAll")(function* (
      inputs: ReadonlyArray<ThreadLiveInput>,
    ) {
      yield* mutex.withPermits(1)(
        Effect.forEach(
          inputs,
          (input) =>
            Effect.gen(function* () {
              yield* budget.check;
              if (input.kind === "event") {
                yield* budget.retain(input).pipe(
                  Effect.tap((item) => Effect.sync(() => pendingUpdates.push(item))),
                  Effect.uninterruptible,
                );
              }
              if (input.kind === "event" && coalescibleUpdateKey(input) !== null) {
                if (pendingUpdates.length === 1) {
                  const generation = ++windowGeneration;
                  windowFiber = yield* Effect.forkIn(flushWindow(generation), coalescerScope);
                }
                if (pendingUpdates.length >= MAX_PENDING_UPDATES) {
                  yield* cancelWindow();
                  windowGeneration += 1;
                  yield* flushPending();
                }
                return;
              }

              yield* cancelWindow();
              windowGeneration += 1;
              // A non-update event closes the run immediately. The coalescer keeps
              // that boundary after the final update from the run.
              yield* flushPending();
              if (input.kind === "synchronized") {
                yield* budget.retain({ kind: "synchronized" as const }).pipe(
                  Effect.flatMap((marker) => Queue.offer(output, marker)),
                  Effect.uninterruptible,
                );
              }
            }),
          { discard: true },
        ),
      );
    });

    const close = (cause?: Cause.Cause<E | LiveStreamBufferError>) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed) {
            return;
          }
          closed = true;
          windowGeneration += 1;
          yield* cancelWindow();
          budget.release(pendingUpdates);
          pendingUpdates = [];
          budget.release(yield* Queue.clear(output).pipe(Effect.orElseSucceed(() => [])));
          if (cause) {
            yield* Queue.failCause(output, cause);
          }
          yield* Queue.shutdown(output);
          yield* Deferred.succeed(cleanupComplete, undefined);
        }),
      );

    yield* Effect.addFinalizer(() => close());
    yield* budget.failed.pipe(
      Effect.catchTags({ LiveStreamBufferError: (error) => close(Cause.fail(error)) }),
      Effect.forkScoped,
    );

    return {
      offer: (input: ThreadLiveInput) => offerAll([input]),
      close,
      end: mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* cancelWindow();
          windowGeneration += 1;
          yield* flushPending();
          yield* Queue.end(output);
        }),
      ),
      offerAll,
      stream: budget.deliver(Stream.fromQueue(output)),
      failed: budget.failed,
      closed: Deferred.await(cleanupComplete),
      usage: budget.usage,
    } as const;
  });

/** Keep streaming updates within a bounded live window; lifecycle events flush it immediately. */
export const coalesceThreadLiveStream = <E, R>(source: Stream.Stream<ThreadLiveEvent, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const coalescer = yield* makeThreadLiveEventCoalescer<E>();
      yield* source.pipe(
        Stream.runForEachArray(coalescer.offerAll),
        Effect.andThen(coalescer.end),
        Effect.raceFirst(coalescer.failed),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) ? coalescer.close(exit.cause) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      return coalescer.stream;
    }),
  );
