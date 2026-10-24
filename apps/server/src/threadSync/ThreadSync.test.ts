import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  THREAD_REPLICATION_BATCH_BYTES,
  type OrchestrationV2DomainEvent,
  ThreadId,
  ThreadReplicationApply,
} from "@t3tools/contracts";
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
        expect((yield* held()).length).toBe(5);

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

describe("replication safety regressions", () => {
  it.live(
    "a spoke cannot steal another spoke's thread by increasing its epoch, even after unpairing",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("claim-hub", "cloud-server");
        const owner = yield* start("claim-owner", "computer");
        const peer = yield* start("claim-peer", "computer");
        yield* pair(hub, owner);
        yield* pair(hub, peer);
        const at = yield* DateTime.now;
        yield* owner.sink.write({ events: [thread("event:original", at)] });
        yield* owner.sync.sync(hub.environmentId);
        yield* hub.machines.unpair({ environmentId: owner.environmentId });
        yield* hub.replication.receive(
          {
            after: { events: 0, meta: 0 },
            cursor: { events: 1, meta: 0 },
            meta: [
              { threadId, owner: peer.environmentId, epoch: 50, folderId: null, source: null },
            ],
            events: [encodeEvent(thread("event:hijack", at, "hijacked"))],
          },
          peer.environmentId,
          false,
        );
        expect((yield* hub.replication.owner(threadId))?.owner).toBe(owner.environmentId);
        expect((yield* hub.projections.getThread(threadId)).title).toBe("On the laptop");
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "globally keyed messages cannot be moved into a peer's thread",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("identity-hub", "cloud-server");
        const peer = yield* start("identity-peer", "computer");
        yield* pair(hub, peer);
        const at = yield* DateTime.now;
        yield* hub.sink.write({
          events: [thread("event:victim", at), message("event:message", at, "keep me")],
        });
        const attacker = ThreadId.make("thread:attacker");
        const stolen = forThread(attacker, message("event:message", at, "stolen"));
        const rejected = yield* Effect.result(
          hub.replication.receive(
            {
              after: { events: 0, meta: 0 },
              cursor: { events: 2, meta: 0 },
              meta: [
                {
                  threadId: attacker,
                  owner: peer.environmentId,
                  epoch: 0,
                  folderId: null,
                  source: null,
                },
              ],
              events: [
                encodeEvent(forThread(attacker, thread("event:attacker", at))),
                encodeEvent(stolen),
              ],
            },
            peer.environmentId,
            false,
          ),
        );
        expect(rejected._tag).toBe("Failure");
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map((x) => x.text),
        ).toEqual(["keep me"]);
        expect((yield* hub.replication.cursors(peer.environmentId)).received.events).toBe(0);
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "unknown event and metadata fields survive a relay and ownership transfer",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("raw-hub", "cloud-server");
        const peer = yield* start("raw-peer", "computer");
        const other = yield* start("raw-other", "computer");
        yield* pair(hub, peer);
        yield* pair(hub, other);
        const at = yield* DateTime.now;
        const event = encodeEvent(message("event:raw-message", at, "hello"));
        const raw = {
          ...(event as object),
          futureEnvelope: { version: 12 },
          payload: {
            ...(event as { payload: object }).payload,
            futurePayload: { important: true },
          },
        };
        yield* hub.replication.receive(
          {
            after: { events: 0, meta: 0 },
            cursor: { events: 2, meta: 0 },
            events: [encodeEvent(thread("event:raw-thread", at)), raw],
            meta: [
              {
                threadId,
                owner: peer.environmentId,
                epoch: 0,
                folderId: null,
                source: null,
                futureMeta: "keep",
              },
            ],
          },
          peer.environmentId,
          false,
        );
        yield* hub.sync.sync(other.environmentId);
        const relayed = yield* other.replication.readBatch(
          { events: 0, meta: 0 },
          hub.environmentId,
          false,
        );
        expect(relayed.events).toContainEqual(raw);
        expect(relayed.meta[0]).toMatchObject({ futureMeta: "keep" });
        yield* hub.replication.take(threadId, peer.environmentId, 1);
        const moved = yield* hub.replication.readBatch(
          { events: 0, meta: 0 },
          other.environmentId,
          true,
        );
        expect(moved.events).toContainEqual(raw);
        expect(moved.meta[0]).toMatchObject({ owner: hub.environmentId, futureMeta: "keep" });
      }).pipe(Effect.scoped),
    30000,
  );

  it.live(
    "a failed projection does not acknowledge or lose an event on retry",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("retry-hub", "cloud-server");
        const peer = yield* start("retry-peer", "computer");
        yield* pair(hub, peer);
        const at = yield* DateTime.now;
        yield* peer.sink.write({
          events: [thread("event:retry-thread", at), message("event:retry-message", at, "once")],
        });
        yield* hub.sql`CREATE TRIGGER reject_message BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(FAIL, 'test failure'); END`;
        expect((yield* Effect.result(peer.sync.sync(hub.environmentId)))._tag).toBe("Failure");
        expect((yield* hub.replication.cursors(peer.environmentId)).received.events).toBe(0);
        yield* hub.sql`DROP TRIGGER reject_message`;
        yield* peer.sync.sync(hub.environmentId);
        yield* peer.sync.sync(hub.environmentId);
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map((x) => x.text),
        ).toEqual(["once"]);
        expect(yield* hub.replication.eventCount(threadId)).toBe(2);
      }).pipe(Effect.scoped),
    30000,
  );
});

it.live(
  "a 700-thread backfill stays within the wire budget and a move can sync beyond 64 batches",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("backfill-hub", "cloud-server");
      const peer = yield* start("backfill-peer", "computer");
      yield* pair(hub, peer);
      const at = yield* DateTime.now;
      const many = Array.from({ length: 700 }, (_, index) =>
        forThread(ThreadId.make(`thread:backfill-${index}`), thread(`event:backfill-${index}`, at)),
      );
      yield* peer.sink.write({
        events: [
          ...many,
          thread("event:large-thread", at),
          ...Array.from({ length: 70 }, (_, index) =>
            message(
              `event:large-${index}`,
              DateTime.add(at, { seconds: index }),
              "x".repeat(150 * 1024),
            ),
          ),
        ],
      });
      const batches: Array<number> = [];
      let cursor = { events: 0, meta: 0 };
      for (;;) {
        const batch = yield* peer.replication.readBatch(cursor, hub.environmentId, true);
        if (batch.cursor.events === cursor.events && batch.cursor.meta === cursor.meta) break;
        batches.push(Buffer.byteLength(JSON.stringify(batch)));
        expect(batches.at(-1)).toBeLessThanOrEqual(THREAD_REPLICATION_BATCH_BYTES);
        cursor = batch.cursor;
      }
      expect(batches.length).toBeGreaterThan(64);
      yield* peer.sync.syncThrough(hub.environmentId, cursor.events);
      expect((yield* peer.replication.cursors(hub.environmentId)).acknowledged.events).toBe(
        cursor.events,
      );
      expect(yield* hub.replication.eventCount(threadId)).toBe(71);
      expect(
        (yield* hub.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
      ).toBe(701);
    }).pipe(Effect.scoped),
  60000,
);
