/**
 * The seam where each provider turn picks up the paired-machines block. The
 * machine link registers a reader once it exists; until then, and on a
 * standalone server, turns get nothing. Kept as a registry so turn start does
 * not depend on the machine link and the link does not depend on the runtime.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export class MachinesTurnContext extends Context.Service<
  MachinesTurnContext,
  {
    /** The reader must answer from memory: turn start awaits it. */
    readonly register: (read: Effect.Effect<string>) => Effect.Effect<void, never, Scope.Scope>;
    /** The block for this turn, or "" when there is nothing to say. */
    readonly read: Effect.Effect<string>;
  }
>()("cogenly-server/orchestration-v2/MachinesTurnContext") {}

export const layer = Layer.effect(
  MachinesTurnContext,
  Effect.gen(function* () {
    const current = yield* Ref.make<Effect.Effect<string> | undefined>(undefined);
    return MachinesTurnContext.of({
      register: (read) =>
        Effect.acquireRelease(Ref.set(current, read), () => Ref.set(current, undefined)),
      read: Ref.get(current).pipe(
        Effect.flatMap((read) => read ?? Effect.succeed("")),
        Effect.catchCause(() => Effect.succeed("")),
      ),
    });
  }),
);
