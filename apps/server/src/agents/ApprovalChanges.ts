import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Fires whenever an `agent_approvals` row is created or decided. Approvals are
 * written by Vault, AccountAccess and AgentWorkspaceService alike; subscribers
 * re-read the pending list rather than trusting a payload.
 */
export class ApprovalChanges extends Context.Service<
  ApprovalChanges,
  {
    readonly notify: Effect.Effect<void>;
    /** Subscribe before reading the current list, so a change in between is not missed. */
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("cogenly-server/agents/ApprovalChanges") {}

export const layer = Layer.effect(
  ApprovalChanges,
  Effect.gen(function* () {
    const changed = yield* PubSub.sliding<void>(1);
    return ApprovalChanges.of({
      notify: PubSub.publish(changed, undefined).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(changed).pipe(Effect.map(Stream.fromSubscription)),
    });
  }),
);

/**
 * Yield while building a service. Optional so units built without the signal
 * (most unit tests) still work; the runtime layer always provides it.
 */
export const optional = Effect.serviceOption(ApprovalChanges).pipe(
  Effect.map((changes) =>
    changes._tag === "Some"
      ? changes.value
      : ApprovalChanges.of({ notify: Effect.void, subscribe: Effect.succeed(Stream.empty) }),
  ),
);
