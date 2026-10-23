import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { forkParked } from "../serverActivation.ts";

/** Sources load due work from their durable state; registration owns its execution lifetime. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>;
  }
>()("cogenly-server/scheduling/Scheduler") {}

/**
 * One scheduler runs per process, so its heartbeat is process state: epoch
 * milliseconds of the last tick, or null before the first one. `GET /health`
 * reads it without needing the Scheduler service, which keeps probes working
 * where the service is not in scope.
 */
const schedulerHeartbeatRef = Ref.makeUnsafe<number | null>(null);

export const lastSchedulerTickAtMs: Effect.Effect<number | null> = Ref.get(schedulerHeartbeatRef);

const make = Effect.gen(function* () {
  const sources = yield* Ref.make(new Map<symbol, Effect.Effect<void>>());
  const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <
    E,
    R,
  >(name: string, runDueWork: Effect.Effect<void, E, R>) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const permit = yield* Semaphore.make(1);
    const run = runDueWork.pipe(
      Effect.provideContext(context),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Scheduler source failed", { source: name, cause }),
      ),
      permit.withPermitsIfAvailable(1),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
    const id = Symbol(name);
    yield* Effect.acquireRelease(
      Ref.update(sources, (current) => new Map(current).set(id, run)),
      () =>
        Ref.update(sources, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    );
    // Due work waits for startup recovery, which would cancel runs it started.
    yield* forkParked(run);
  });
  // The heartbeat lands before the sources run: a stuck source must not
  // look like a dead scheduler.
  const tick = Clock.currentTimeMillis.pipe(
    Effect.tap((now) => Ref.set(schedulerHeartbeatRef, now)),
    Effect.andThen(Ref.get(sources)),
    Effect.flatMap((current) => Effect.forEach(current.values(), (run) => run, { discard: true })),
  );
  // One clock for all due-work sources. A slow source cannot block another
  // source or overlap itself, and no extra missed-tick backlog is queued.
  yield* forkParked(Effect.sleep("5 seconds").pipe(Effect.andThen(tick), Effect.forever));
  return Scheduler.of({ register });
});

export const layer = Layer.effect(Scheduler, make);
