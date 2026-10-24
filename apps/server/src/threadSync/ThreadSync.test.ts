import { describe, expect, it } from "@effect/vitest";
import { ThreadReplicationApply } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { pair } from "../machines/testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import {
  startThreadMachine as start,
  threadCreated as thread,
  threadId,
  userMessage as message,
} from "./testkit.ts";

describe("thread replication over the machine link", () => {
  it.live(
    "the hub follows a spoke's thread, relays it, and never writes it locally",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("threads-hub", "cloud-server");
        const laptop = yield* start("threads-laptop", "computer");
        const other = yield* start("threads-other", "computer");
        yield* pair(hub, laptop);
        yield* pair(hub, other);
        const at = yield* DateTime.now;
        yield* laptop.sink.write({
          events: [thread("event:created", at), message("event:one", at, "hello")],
        });

        yield* laptop.sync.sync(hub.environmentId);
        const replica = yield* hub.projections.getThreadProjection(threadId);
        expect(replica.thread.title).toBe("On the laptop");
        expect(replica.messages.map((entry) => entry.text)).toEqual(["hello"]);
        expect((yield* hub.replication.owner(threadId))?.owner).toBe(laptop.environmentId);
        // The thread list names the machine that runs a thread, and only for replicas.
        expect(replica.thread.ownerMachine).toBe(laptop.environmentId);
        expect(
          (yield* laptop.projections.getThreadProjection(threadId)).thread.ownerMachine,
        ).toBeNull();
        const local = yield* Effect.flip(
          hub.sink.write({ events: [message("event:hub", at, "x")] }),
        );
        expect(local.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);

        // Live follow: the next event and a repeated push apply once.
        yield* laptop.sink.write({ events: [message("event:two", at, "again")] });
        yield* laptop.sync.sync(hub.environmentId);
        const repeated = yield* laptop.replication.readBatch(
          { events: 0, meta: 0 },
          hub.environmentId,
          true,
        );
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, repeated);
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map(
            (entry) => entry.text,
          ),
        ).toEqual(["hello", "again"]);
        const copies = yield* hub.sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId}`;
        expect(copies[0]!.count).toBe(3);

        // The hub sends the laptop nothing of its own thread back.
        yield* hub.sync.sync(laptop.environmentId);
        expect(yield* laptop.replication.owner(threadId)).toBeUndefined();

        // Another spoke gets the thread through the hub, owned by the laptop.
        yield* hub.sync.sync(other.environmentId);
        expect((yield* other.projections.getThreadProjection(threadId)).messages.length).toBe(2);
        expect((yield* other.replication.owner(threadId))?.owner).toBe(laptop.environmentId);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a peer cannot claim a thread for another machine or overwrite one it does not own",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("forge-hub", "cloud-server");
        const laptop = yield* start("forge-laptop", "computer");
        yield* pair(hub, laptop);
        const at = yield* DateTime.now;
        yield* hub.sink.write({ events: [thread("event:hub-own", at, "Hub's own")] });
        const forged = yield* Effect.result(
          laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
            after: { events: 0, meta: 0 },
            cursor: { events: 1, meta: 0 },
            events: [thread("event:forged", at, "Forged")],
            meta: [{ threadId, owner: hub.environmentId, epoch: 0, folderId: null, source: null }],
          }),
        );
        expect(forged._tag).toBe("Failure");
        // Claiming its own authorship for the hub's thread is skipped, not applied.
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
          after: { events: 0, meta: 0 },
          cursor: { events: 1, meta: 0 },
          events: [thread("event:overwrite", at, "Overwritten")],
          meta: [{ threadId, owner: laptop.environmentId, epoch: 0, folderId: null, source: null }],
        });
        expect((yield* hub.projections.getThreadProjection(threadId)).thread.title).toBe(
          "Hub's own",
        );
      }).pipe(Effect.scoped),
    30000,
  );
});
