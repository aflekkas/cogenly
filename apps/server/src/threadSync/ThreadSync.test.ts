import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  ThreadId,
  ThreadReplicationApply,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { pair } from "../machines/testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import {
  encodeEvent,
  startThreadMachine as start,
  threadCreated as thread,
  threadId,
  userMessage as message,
} from "./testkit.ts";

/** The fixture thread's events, for another thread. */
const forThread = (id: ThreadId, event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent =>
  ({
    ...event,
    id: EventId.make(`${event.id}:${id}`),
    threadId: id,
    payload: { ...event.payload, ...(event.type === "thread.created" ? { id } : { threadId: id }) },
  }) as OrchestrationV2DomainEvent;

describe("thread replication across builds", () => {
  it.live(
    "an older build holds only the thread it cannot read, in order, and replays it after an update",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("compat-hub", "cloud-server");
        const laptop = yield* start("compat-laptop", "computer");
        yield* pair(hub, laptop);
        const at = yield* DateTime.now;
        const newer = ThreadId.make("thread:newer");
        const meta = (id: ThreadId) => ({
          threadId: id,
          owner: laptop.environmentId,
          epoch: 0,
          folderId: null,
          source: null,
        });
        // A newer build's event type, which this build has never seen.
        const reaction = {
          id: "event:reaction",
          type: "message.reaction-added",
          threadId: newer,
          occurredAt: DateTime.formatIso(at),
          payload: { emoji: "🏁" },
        };
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
          after: { events: 0, meta: 0 },
          cursor: { events: 5, meta: 0 },
          events: [
            encodeEvent(forThread(newer, thread("event:created", at))),
            reaction,
            encodeEvent(forThread(newer, message("event:after", at, "after the reaction"))),
            encodeEvent(thread("event:created", at)),
            encodeEvent(message("event:one", at, "hello")),
          ],
          meta: [meta(newer), meta(threadId)],
        });
        // The readable thread syncs; the stream moves on.
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map(
            (entry) => entry.text,
          ),
        ).toEqual(["hello"]);
        expect((yield* hub.replication.cursors(laptop.environmentId)).received.events).toBe(5);
        // The other thread is held whole, so nothing of it applies out of order,
        // and later items for it wait behind the ones held.
        expect(yield* Effect.flip(hub.projections.getThreadProjection(newer))).toBeDefined();
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
          after: { events: 5, meta: 0 },
          cursor: { events: 6, meta: 0 },
          events: [encodeEvent(forThread(newer, message("event:later", at, "later")))],
          meta: [meta(newer)],
        });
        const held = () =>
          hub.sql<{
            readonly thread_id: string;
          }>`SELECT thread_id FROM thread_replication_deferred ORDER BY seq`;
        expect((yield* held()).length).toBe(6);

        // An update that reads every held item replays the thread in its order.
        yield* hub.sql`DELETE FROM thread_replication_deferred WHERE item_json LIKE '%event:reaction%'`;
        yield* hub.restartReplication;
        expect(
          (yield* hub.projections.getThreadProjection(newer)).messages.map((entry) => entry.text),
        ).toEqual(["after the reaction", "later"]);
        expect(yield* held()).toEqual([]);
      }).pipe(Effect.scoped),
    30000,
  );
});

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
            events: [encodeEvent(thread("event:forged", at, "Forged"))],
            meta: [{ threadId, owner: hub.environmentId, epoch: 0, folderId: null, source: null }],
          }),
        );
        expect(forged._tag).toBe("Failure");
        // Claiming its own authorship for the hub's thread is skipped, not applied.
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
          after: { events: 0, meta: 0 },
          cursor: { events: 1, meta: 0 },
          events: [encodeEvent(thread("event:overwrite", at, "Overwritten"))],
          meta: [{ threadId, owner: laptop.environmentId, epoch: 0, folderId: null, source: null }],
        });
        expect((yield* hub.projections.getThreadProjection(threadId)).thread.title).toBe(
          "Hub's own",
        );
      }).pipe(Effect.scoped),
    30000,
  );
});
