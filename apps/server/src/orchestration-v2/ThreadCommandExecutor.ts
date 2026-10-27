import type { ThreadId } from "@cogenly/contracts";
import * as KeyedLock from "@cogenly/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /** Holds admission until restart after a successful handoff; reopens on failure. */
    readonly withIdleHandoff: <A, E, R>(
      handoff: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("cogenly-server/orchestration-v2/ThreadCommandExecutor") {}

const make = Effect.gen(function* () {
  const locks = yield* KeyedLock.make<ThreadId>();
  let admitted = 0;
  let paused: Deferred.Deferred<void> | undefined;
  const enter: Effect.Effect<void> = Effect.suspend(() => {
    if (paused !== undefined)
      return Deferred.await(paused).pipe(Effect.interruptible, Effect.andThen(enter));
    admitted++;
    return Effect.void;
  });
  return ThreadCommandExecutor.of({
    activeKeys: locks.activeKeys,
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        enter,
        () => locks.withLock(key, effect),
        () =>
          Effect.sync(() => {
            admitted--;
          }),
      ),
    withIdleHandoff: (handoff) =>
      Effect.suspend(() => {
        // Entry and closing admission are synchronous, so a command either counts
        // in the final busy check or waits for the next server process.
        let accepted = false;
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            if (admitted > 0 || paused !== undefined) return false;
            paused = Deferred.makeUnsafe<void>();
            return true;
          }),
          (closed) =>
            closed
              ? handoff.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      accepted = true;
                    }),
                  ),
                  Effect.asSome,
                )
              : Effect.succeedNone,
          (closed) =>
            Effect.suspend(() => {
              if (!closed || accepted || paused === undefined) return Effect.void;
              const resume = paused;
              paused = undefined;
              return Deferred.succeed(resume, undefined);
            }),
        );
      }),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
