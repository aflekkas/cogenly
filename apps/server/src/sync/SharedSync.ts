import {
  SharedChangesApply,
  SharedChangesRead,
  SharedStateError,
  type EnvironmentId,
  type SharedChangeBatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SharedState from "./SharedState.ts";

export class SharedSync extends Context.Service<
  SharedSync,
  {
    /** One bounded catch-up pass; scheduler retries durable cursors after a lost connection. */
    readonly sync: (peer: EnvironmentId) => Effect.Effect<void, SharedStateError>;
  }
>()("cogenly-server/sync/SharedSync") {}
const make = Effect.gen(function* () {
  const state = yield* SharedState.SharedState;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const scheduler = yield* Scheduler.Scheduler;
  const permit = yield* Semaphore.make(1);
  const topology = machines.list.pipe(
    Effect.mapError((cause) => new SharedStateError({ reason: "storage", cause })),
  );
  yield* channels.register(SharedChangesRead, ({ after }, caller) =>
    Effect.gen(function* () {
      const { link } = yield* topology;
      return yield* state.readBatch(after, caller.environmentId, link._tag === "spoke");
    }),
  );
  const receive = Effect.fn("SharedSync.receive")(function* (
    batch: SharedChangeBatch,
    source: EnvironmentId,
  ) {
    const view = yield* topology;
    const trustedRelay = view.link._tag === "spoke" && view.link.hubEnvironmentId === source;
    if (!trustedRelay) {
      const known = new Set(view.machines.map((machine) => machine.environmentId as string));
      for (const change of batch.changes)
        if (
          typeof change.fields.ownerMachine === "string" &&
          !known.has(change.fields.ownerMachine)
        ) {
          const current = yield* state.get(change.kind, change.id);
          if (current?.fields.ownerMachine !== change.fields.ownerMachine)
            return yield* new SharedStateError({ reason: "owner-change" });
        }
    }
    return yield* state.receive(batch, source, trustedRelay);
  });
  yield* channels.register(SharedChangesApply, (batch, caller) =>
    receive(batch, caller.environmentId),
  );
  const sync: SharedSync["Service"]["sync"] = (peer) =>
    Effect.gen(function* () {
      const view = yield* topology;
      const spoke = view.link._tag === "spoke";
      if (view.link._tag === "standalone") return;
      if (
        !view.machines.some(
          (machine) =>
            machine.environmentId === peer &&
            machine.online &&
            (machine.relation === "hub" || machine.relation === "spoke"),
        )
      )
        return;
      yield* state.setHub(spoke && view.link._tag === "spoke" ? view.link.hubEnvironmentId : null);
      yield* state.bootstrap;
      // A busy link yields after 64 bounded batches; its durable cursor resumes next tick.
      for (let count = 0; count < 64; count++) {
        const cursors = yield* state.cursors(peer);
        const outgoing = yield* state.readBatch(cursors.acknowledged, peer, spoke);
        if (outgoing.cursor === outgoing.after) break;
        const result = yield* machines
          .call(peer, SharedChangesApply, outgoing)
          .pipe(Effect.timeout("15 seconds"));
        // Only a committed batch is an acknowledgement; don't trust an arbitrary peer cursor.
        if (result.acknowledged < outgoing.cursor)
          return yield* new SharedStateError({ reason: "invalid-cursor" });
        yield* state.acknowledge(peer, result.acknowledged);
      }
      for (let count = 0; count < 64; count++) {
        const after = (yield* state.cursors(peer)).received;
        const batch = yield* machines
          .call(peer, SharedChangesRead, { after })
          .pipe(Effect.timeout("15 seconds"));
        if (batch.after !== after) return yield* new SharedStateError({ reason: "invalid-cursor" });
        if (batch.cursor === after) break;
        yield* receive(batch, peer);
      }
    }).pipe(
      Effect.mapError((cause) =>
        isSharedStateError(cause) ? cause : new SharedStateError({ reason: "storage", cause }),
      ),
      permit.withPermits(1),
    );
  const catchUp = Effect.gen(function* () {
    const view = yield* topology;
    yield* state.setHub(view.link._tag === "spoke" ? view.link.hubEnvironmentId : null);
    for (const machine of view.machines)
      if (machine.online && (machine.relation === "hub" || machine.relation === "spoke"))
        yield* sync(machine.environmentId).pipe(
          Effect.catchTags({
            SharedStateError: (error) =>
              Effect.logWarning("Shared document peer catch-up deferred", {
                peer: machine.environmentId,
                reason: error.reason,
              }),
          }),
        );
  });
  const safeCatchUp = catchUp.pipe(
    Effect.catchTags({
      SharedStateError: (error) =>
        Effect.logWarning("Shared document catch-up deferred", { reason: error.reason }),
    }),
  );
  yield* scheduler.register("shared-documents", safeCatchUp);
  yield* Stream.merge(machines.subscribe.pipe(Stream.as(undefined)), state.changes).pipe(
    Stream.runForEach(() => safeCatchUp),
    Effect.forkScoped,
  );
  return SharedSync.of({ sync });
});
const isSharedStateError = Schema.is(SharedStateError);
export const layer = Layer.effect(SharedSync, make);
