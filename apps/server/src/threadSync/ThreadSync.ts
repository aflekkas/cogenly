/**
 * ThreadSync: moves thread replication batches over the machine link. Each
 * side pushes what the other has not acknowledged, after every local commit
 * (coalesced) and on the scheduler tick, which also catches up after a
 * reconnect. Durable cursors make a lost reply or a repeated push harmless.
 */
import {
  type EnvironmentId,
  ThreadReplicationApply,
  type ThreadReplicationBatch,
  ThreadReplicationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadReplication from "./ThreadReplication.ts";

export class ThreadSync extends Context.Service<
  ThreadSync,
  {
    /** Push everything `peer` has not acknowledged, in bounded batches. */
    readonly sync: (peer: EnvironmentId) => Effect.Effect<void, ThreadReplicationError>;
    /** One pass over every online paired machine. */
    readonly catchUp: Effect.Effect<void>;
  }
>()("cogenly-server/threadSync/ThreadSync") {}

const isReplicationError = Schema.is(ThreadReplicationError);

const make = Effect.gen(function* () {
  const replication = yield* ThreadReplication.ThreadReplication;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const scheduler = yield* Scheduler.Scheduler;
  const permit = yield* Semaphore.make(1);
  const topology = machines.list.pipe(
    Effect.mapError((cause) => new ThreadReplicationError({ reason: "storage", cause })),
  );

  yield* channels.register(ThreadReplicationApply, (batch, caller) =>
    Effect.gen(function* () {
      const { link } = yield* topology;
      // A spoke trusts relayed authorship only from the hub it pinned.
      const trustedRelay = link._tag === "spoke" && link.hubEnvironmentId === caller.environmentId;
      return yield* replication.receive(batch, caller.environmentId, trustedRelay);
    }),
  );

  const sync: ThreadSync["Service"]["sync"] = (peer) =>
    Effect.gen(function* () {
      const view = yield* topology;
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
      const spoke = view.link._tag === "spoke";
      // A busy log yields after 64 batches; the durable cursor resumes next pass.
      for (let count = 0; count < 64; count++) {
        const { acknowledged } = yield* replication.cursors(peer);
        const batch: ThreadReplicationBatch = yield* replication.readBatch(
          acknowledged,
          peer,
          spoke,
        );
        if (batch.cursor.events === batch.after.events && batch.cursor.meta === batch.after.meta)
          break;
        const result = yield* machines
          .call(peer, ThreadReplicationApply, batch)
          .pipe(Effect.timeout("30 seconds"));
        // Only a committed batch acknowledges; never trust a cursor past what was sent.
        if (
          result.acknowledged.events < batch.cursor.events ||
          result.acknowledged.meta < batch.cursor.meta
        )
          return yield* new ThreadReplicationError({ reason: "invalid-cursor" });
        yield* replication.acknowledge(peer, batch.cursor);
      }
    }).pipe(
      Effect.mapError((cause) =>
        isReplicationError(cause)
          ? cause
          : new ThreadReplicationError({ reason: "storage", cause }),
      ),
      permit.withPermits(1),
    );

  const catchUp: ThreadSync["Service"]["catchUp"] = Effect.gen(function* () {
    const view = yield* topology;
    for (const machine of view.machines)
      if (machine.online && (machine.relation === "hub" || machine.relation === "spoke"))
        yield* sync(machine.environmentId).pipe(
          Effect.catchTags({
            ThreadReplicationError: (error) =>
              Effect.logWarning("Thread replication to a paired machine deferred", {
                peer: machine.environmentId,
                reason: error.reason,
              }),
          }),
        );
  }).pipe(
    Effect.catchTags({
      ThreadReplicationError: (error) =>
        Effect.logWarning("Thread replication deferred", { reason: error.reason }),
    }),
  );

  yield* scheduler.register("thread-replication", catchUp);
  // A streaming turn commits many events; a sliding queue of one coalesces
  // them into at most one pending pass behind the running one.
  const pending = yield* Queue.sliding<void>(1);
  yield* Stream.merge(machines.subscribe.pipe(Stream.as(undefined)), replication.changes).pipe(
    Stream.runForEach(() => Queue.offer(pending, undefined)),
    Effect.forkScoped,
  );
  yield* Queue.take(pending).pipe(Effect.andThen(catchUp), Effect.forever, Effect.forkScoped);
  return ThreadSync.of({ sync, catchUp });
});

export const layer = Layer.effect(ThreadSync, make);
