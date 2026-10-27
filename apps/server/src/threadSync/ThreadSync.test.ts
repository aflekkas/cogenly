import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectLabelId,
  THREAD_REPLICATION_BATCH_BYTES,
  type OrchestrationV2DomainEvent,
  ThreadId,
  ThreadReplicationApply,
  CommandId,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { LockTimeoutError, SqlError } from "effect/sql/SqlError";

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

it.live(
  "targeted pages bypass bulk history, relay ownership, and deduplicate when bulk catches up",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("priority-hub", "cloud-server");
      const laptop = yield* start("priority-laptop", "computer");
      const caller = yield* start("priority-caller", "computer");
      yield* pair(hub, laptop);
      yield* pair(hub, caller);
      const at = yield* DateTime.now;
      const events = [
        thread("event:priority", at),
        ...Array.from({ length: 300 }, (_, i) =>
          message(`event:priority:${i}`, at, `Message ${i}`),
        ),
      ];
      yield* laptop.sink.write({ events });
      const before = yield* caller.replication.cursors(hub.environmentId);
      yield* caller.routing.refreshDelegated(laptop.environmentId, threadId);
      expect((yield* caller.projections.getThreadProjection(threadId)).messages).toHaveLength(300);
      expect(yield* caller.replication.cursors(hub.environmentId)).toEqual(before);
      expect((yield* hub.replication.owner(threadId))?.owner).toBe(laptop.environmentId);
      // The hub can route a stop even though its child history is still absent.
      expect(
        yield* caller.remoteCommands.forward({
          type: "thread.stop",
          threadId,
          commandId: CommandId.make("priority-stop"),
        }),
      ).toMatchObject({ _tag: "Some" });
      yield* laptop.sync.sync(hub.environmentId);
      yield* hub.sync.sync(caller.environmentId);
      expect(yield* caller.replication.eventCount(threadId)).toBe(events.length);
      yield* caller.routing.refreshDelegated(laptop.environmentId, threadId);
      expect((yield* caller.projections.getThreadProjection(threadId)).messages).toHaveLength(300);
    }),
);

describe("thread replication across builds", () => {
  it.live("delayed owner metadata keeps a replica filed in the merged project", () =>
    Effect.gen(function* () {
      const hub = yield* start("merge-hub", "cloud-server");
      const laptop = yield* start("merge-laptop", "computer");
      yield* pair(hub, laptop);
      const source = ProjectLabelId.make("label:source");
      const target = ProjectLabelId.make("label:target");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const project = {
        name: "Project",
        color: null,
        description: null,
        instructions: "",
        archivedAt: null,
        repositories: [],
        sourceLinks: [],
        createdAt,
      };
      yield* hub.shared.write("project", source, project);
      yield* hub.shared.write("project", target, project);
      yield* laptop.shared.write("project", source, project);
      const at = yield* DateTime.now;
      yield* laptop.sink.write({ events: [thread("event:created", at)] });
      yield* laptop.sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${source})`;
      yield* laptop.sync.sync(hub.environmentId);
      yield* hub.shared.write(
        "project",
        source,
        { mergedInto: target, mergeSourceName: "Project" },
        true,
      );
      expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectFolderId).toBe(
        target,
      );
      // The offline owner has not received the merge yet and sends its old filing again.
      yield* laptop.sql`DELETE FROM thread_project_labels WHERE thread_id=${threadId}`;
      yield* laptop.sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${source})`;
      yield* laptop.sink.write({ events: [message("event:later", at, "Still here")] });
      yield* laptop.sync.sync(hub.environmentId);
      expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectFolderId).toBe(
        target,
      );
      expect((yield* hub.replication.owner(threadId))?.owner).toBe(laptop.environmentId);
      expect(
        (yield* hub.projections.getThreadProjection(threadId)).messages.map((entry) => entry.text),
      ).toEqual(["Still here"]);
    }),
  );

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
        expect(forged._tag).toBe("Success");
        expect((yield* hub.sql`SELECT reason FROM thread_replication_deferred`)[0]?.reason).toBe(
          "wrong-owner",
        );
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
        expect(rejected._tag).toBe("Success");
        expect(
          (yield* hub.sql`SELECT DISTINCT reason FROM thread_replication_deferred`)[0]?.reason,
        ).toBe("projection");
        expect(
          (yield* hub.projections.getThreadProjection(threadId)).messages.map((x) => x.text),
        ).toEqual(["keep me"]);
        expect((yield* hub.replication.cursors(peer.environmentId)).received.events).toBe(2);
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
    "a deterministic projection failure is quarantined and replayed without resending",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("retry-hub", "cloud-server");
        const peer = yield* start("retry-peer", "computer");
        yield* pair(hub, peer);
        const at = yield* DateTime.now;
        const good = ThreadId.make("thread:projection-good");
        yield* peer.sink.write({
          events: [
            thread("event:retry-thread", at),
            message("event:retry-message", at, "once"),
            forThread(good, thread("event:projection-good", at)),
            forThread(good, message("event:projection-good-message", at, "unblocked")),
          ],
        });
        yield* hub.sql`CREATE TRIGGER reject_message BEFORE INSERT ON orchestration_v2_projection_messages WHEN NEW.thread_id = 'thread:on-laptop' BEGIN SELECT RAISE(FAIL, 'test failure'); END`;
        yield* peer.sync.sync(hub.environmentId);
        expect((yield* hub.replication.cursors(peer.environmentId)).received.events).toBe(4);
        expect(
          (yield* hub.projections.getThreadProjection(good)).messages.map((row) => row.text),
        ).toEqual(["unblocked"]);
        expect(
          (yield* hub.sql`SELECT DISTINCT reason FROM thread_replication_deferred`)[0]?.reason,
        ).toBe("projection");
        yield* hub.sql`DROP TRIGGER reject_message`;
        yield* hub.replication.replayHeld;
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

it.live(
  "first backfill preserves and relays filing until its project arrives",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("late-project-hub", "cloud-server");
      const laptop = yield* start("late-project-owner", "computer");
      const other = yield* start("late-project-other", "computer");
      yield* pair(hub, laptop);
      yield* pair(hub, other);
      const folderId = ProjectLabelId.make("label:late");
      yield* laptop.shared.write("project", folderId, {
        name: "Late",
        color: null,
        description: null,
        instructions: "",
        archivedAt: null,
        repositories: [],
        sourceLinks: [],
        createdAt: "2026-10-24T00:00:00.000Z",
      });
      const at = yield* DateTime.now;
      yield* laptop.sink.write({ events: [thread("event:late-created", at)] });
      yield* laptop.sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${threadId}, ${folderId})`;
      yield* laptop.machines.call(
        hub.environmentId,
        ThreadReplicationApply,
        yield* laptop.replication.readBatch({ events: 0, meta: 0 }, hub.environmentId, true),
      );
      expect(
        (yield* hub.projections.getThreadProjection(threadId)).thread.projectFolderId,
      ).toBeNull();
      yield* hub.restartReplication;
      yield* hub.machines.call(
        other.environmentId,
        ThreadReplicationApply,
        yield* hub.replication.readBatch({ events: 0, meta: 0 }, other.environmentId, false),
      );
      // The hub must relay the owner's intent even while its own filing is unresolved.
      const relayed = yield* hub.replication.readBatch(
        { events: 0, meta: 0 },
        other.environmentId,
        false,
      );
      expect(relayed.meta).toContainEqual(expect.objectContaining({ threadId, folderId }));
      const projectBatch = yield* laptop.shared.readBatch(0, hub.environmentId, true);
      yield* hub.shared.receive(projectBatch, laptop.environmentId, false);
      expect((yield* hub.projections.getThreadProjection(threadId)).thread.projectFolderId).toBe(
        folderId,
      );
      const relayedProjects = yield* hub.shared.readBatch(0, other.environmentId, false);
      yield* other.shared.receive(relayedProjects, hub.environmentId, true);
      expect((yield* other.projections.getThreadProjection(threadId)).thread.projectFolderId).toBe(
        folderId,
      );
      // A later explicit unfiling replaces the durable intent.
      yield* laptop.sql`DELETE FROM thread_project_labels WHERE thread_id = ${threadId}`;
      yield* laptop.sync.sync(hub.environmentId);
      expect(
        (yield* hub.projections.getThreadProjection(threadId)).thread.projectFolderId,
      ).toBeNull();
    }).pipe(Effect.scoped),
  30000,
);

it.live(
  "held history checks all pages before replay and resumes committed chunks after failure",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("paged-hub", "cloud-server");
      const laptop = yield* start("paged-owner", "computer");
      yield* pair(hub, laptop);
      const at = yield* DateTime.now;
      for (let batch = 0; batch < 3; batch++) {
        const events = Array.from({ length: 100 }, (_, i) => {
          const index = batch * 100 + i;
          return encodeEvent(
            message(
              `event:held:${index}`,
              DateTime.add(at, { milliseconds: index + 1 }),
              `${index}`,
            ),
          );
        });
        if (batch === 0) events.unshift(encodeEvent(thread("event:held-created", at)));
        if (batch === 2)
          events.push({
            id: "event:still-unreadable",
            type: "message.newer-format",
            threadId,
            occurredAt: DateTime.formatIso(at),
            payload: {},
          });
        yield* laptop.machines.call(hub.environmentId, ThreadReplicationApply, {
          after: { events: batch * 100, meta: 0 },
          cursor: { events: (batch + 1) * 100, meta: 0 },
          events,
          meta: [
            {
              threadId,
              owner: laptop.environmentId,
              epoch: "newer-epoch",
              folderId: null,
              source: null,
            },
          ],
        });
      }
      // Simulate a build learning the metadata, with one unreadable event on the last page.
      yield* hub.sql`UPDATE thread_replication_deferred SET item_json = json_set(item_json, '$.epoch', 0) WHERE item_kind = 'meta'`;
      yield* hub.restartReplication;
      expect(yield* hub.replication.eventCount(threadId)).toBe(0);
      yield* hub.sql`DELETE FROM thread_replication_deferred WHERE json_extract(item_json, '$.id') = 'event:still-unreadable'`;
      yield* hub.sql`CREATE TRIGGER interrupt_replay BEFORE INSERT ON orchestration_events
      WHEN NEW.event_id = 'event:held:200' BEGIN SELECT RAISE(ABORT, 'injected replay interruption'); END`;
      yield* hub.restartReplication;
      const committed = yield* hub.replication.eventCount(threadId);
      expect(committed).toBeGreaterThan(0);
      expect(committed).toBeLessThan(301);
      const held = (yield* hub.sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM thread_replication_deferred`)[0]!.count;
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(302);
      yield* hub.sql`DROP TRIGGER interrupt_replay`;
      yield* hub.restartReplication;
      expect(yield* hub.replication.eventCount(threadId)).toBe(301);
      expect(yield* hub.sql`SELECT 1 FROM thread_replication_deferred`).toEqual([]);
      const chunks = yield* hub.sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM orchestration_events
      WHERE stream_id = ${threadId} GROUP BY command_id`;
      expect(Math.max(...chunks.map((chunk) => chunk.count))).toBeLessThanOrEqual(128);
      expect(
        (yield* hub.projections.getThreadProjection(threadId)).messages.map((entry) => entry.text),
      ).toEqual(Array.from({ length: 300 }, (_, i) => `${i}`));
    }).pipe(Effect.scoped),
  30000,
);

it.live.each(["payload", "missing-meta", "missing-thread", "wrong-owner"])(
  "quarantines %s poison without blocking another thread's cursor",
  (kind) =>
    Effect.gen(function* () {
      const hub = yield* start(`poison-${kind}-hub`, "cloud-server");
      const peer = yield* start(`poison-${kind}-peer`, "computer");
      yield* pair(hub, peer);
      const at = yield* DateTime.now;
      const good = ThreadId.make("thread:good");
      yield* peer.sink.write({
        events: [thread("event:bad", at), forThread(good, thread("event:good", at))],
      });
      const batch = yield* peer.replication.readBatch(
        { events: 0, meta: 0 },
        hub.environmentId,
        true,
      );
      const poisoned = {
        ...batch,
        meta:
          kind === "missing-meta"
            ? batch.meta.filter((raw) => (raw as { threadId?: string }).threadId !== threadId)
            : batch.meta.map((raw) =>
                (raw as { threadId?: string }).threadId === threadId && kind === "wrong-owner"
                  ? { ...(raw as object), owner: hub.environmentId }
                  : raw,
              ),
        events: batch.events.map((raw) => {
          if ((raw as { threadId?: string }).threadId !== threadId) return raw;
          if (kind === "missing-thread") return { ...(raw as object), threadId: null };
          if (kind === "payload")
            return {
              ...(raw as object),
              payload: { ...(raw as { payload: object }).payload, id: good },
            };
          return raw;
        }),
      };
      yield* hub.replication.receive(poisoned, peer.environmentId, false);
      expect((yield* hub.projections.getThreadProjection(good)).thread.title).toBe("On the laptop");
      expect((yield* hub.replication.cursors(peer.environmentId)).received).toEqual(batch.cursor);
      expect(
        (yield* hub.sql`SELECT reason FROM thread_replication_deferred WHERE reason IS NOT NULL`)
          .length,
      ).toBeGreaterThan(0);
      if (kind !== "payload") {
        expect(
          (yield* hub.sql`SELECT reason FROM thread_replication_deferred WHERE reason IS NOT NULL`).some(
            (row) => row.reason === kind,
          ),
        ).toBe(true);
        // Upgrade a database written by a build that omitted structural reasons.
        yield* hub.sql`UPDATE thread_replication_deferred SET reason = NULL`;
        yield* hub.restartReplication;
        expect(
          (yield* hub.sql`SELECT reason FROM thread_replication_deferred WHERE reason IS NOT NULL`).some(
            (row) => row.reason === kind,
          ),
        ).toBe(true);
      }
      yield* hub.replication.replayHeld;
      expect((yield* hub.projections.getThreadProjection(good)).thread.title).toBe("On the laptop");
    }).pipe(Effect.scoped),
);

it.live("retries a transient lock without quarantining or advancing the cursor", () =>
  Effect.gen(function* () {
    const hub = yield* start("locked-hub", "cloud-server");
    const peer = yield* start("locked-peer", "computer");
    yield* pair(hub, peer);
    const at = yield* DateTime.now;
    yield* peer.sink.write({ events: [thread("event:lock", at)] });
    const lock = new EventSink.EventSinkWriteError({
      eventCount: 1,
      cause: new SqlError({ reason: new LockTimeoutError({ cause: { code: "SQLITE_BUSY" } }) }),
    });
    const write = vi.spyOn(hub.sink, "writeReplica").mockReturnValueOnce(Effect.fail(lock));
    try {
      const batch = yield* peer.replication.readBatch(
        { events: 0, meta: 0 },
        hub.environmentId,
        true,
      );
      expect(
        yield* Effect.flip(hub.replication.receive(batch, peer.environmentId, false)),
      ).toMatchObject({ reason: "busy" });
      expect((yield* hub.replication.cursors(peer.environmentId)).received.events).toBe(0);
      expect(yield* hub.sql`SELECT 1 FROM thread_replication_deferred`).toEqual([]);
      write.mockReturnValueOnce(Effect.fail(lock));
      expect(
        yield* Effect.flip(peer.machines.call(hub.environmentId, ThreadReplicationApply, batch)),
      ).toMatchObject({ reason: "handler-failed", error: { reason: "storage" } });
      yield* hub.replication.receive(batch, peer.environmentId, false);
      expect(yield* hub.replication.eventCount(threadId)).toBe(1);
    } finally {
      write.mockRestore();
    }
  }).pipe(Effect.scoped),
);

it.effect("the hourly scheduler replays held history after its blocker clears", () =>
  Effect.gen(function* () {
    const hub = yield* start("periodic-hub", "cloud-server");
    const peer = yield* start("periodic-peer", "computer");
    yield* pair(hub, peer);
    const at = yield* DateTime.now;
    yield* peer.sink.write({
      events: [thread("event:periodic", at), message("event:periodic-message", at, "replayed")],
    });
    yield* hub.sql`CREATE TRIGGER reject_periodic BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(FAIL, 'blocked'); END`;
    yield* peer.sync.sync(hub.environmentId);
    const tick = hub.scheduled.get("thread-replication")!;
    yield* tick;
    yield* hub.sql`DROP TRIGGER reject_periodic`;
    yield* TestClock.adjust("1 hour");
    yield* tick;
    expect(
      (yield* hub.projections.getThreadProjection(threadId)).messages.map((row) => row.text),
    ).toEqual(["replayed"]);
    expect(yield* hub.sql`SELECT 1 FROM thread_replication_deferred`).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("discarding a bounded quarantine preserves local history and lets later events apply", () =>
  Effect.gen(function* () {
    const hub = yield* start("discard-hub", "cloud-server");
    const peer = yield* start("discard-peer", "computer");
    yield* pair(hub, peer);
    const at = yield* DateTime.now;
    yield* peer.sink.write({
      events: [thread("event:base", at), message("event:local", at, "kept")],
    });
    yield* peer.sync.sync(hub.environmentId);
    const batch = yield* peer.replication.readBatch(
      { events: 0, meta: 0 },
      hub.environmentId,
      true,
    );
    const before = (yield* hub.replication.cursors(peer.environmentId)).received;
    yield* hub.replication.receive(
      {
        ...batch,
        after: before,
        cursor: { ...before, events: before.events + 1 },
        events: [
          {
            ...(encodeEvent(message("event:poison", at, "bad")) as object),
            payload: { threadId: "another-thread" },
          },
        ],
      },
      peer.environmentId,
      false,
    );
    yield* hub.replication.receive(
      {
        ...batch,
        after: before,
        cursor: { ...before, events: before.events + 1005 },
        events: Array.from({ length: 1005 }, (_, i) =>
          encodeEvent(message(`event:held:${i}`, at, "held")),
        ),
      },
      peer.environmentId,
      false,
    );
    const rows = yield* hub.sql<{ n: number; bytes: number; reason: string }>`SELECT COUNT(*) AS n,
      SUM(length(CAST(item_json AS BLOB))) AS bytes, MIN(reason) AS reason FROM thread_replication_deferred`;
    expect(rows[0]?.n).toBe(1000);
    expect(rows[0]?.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(rows[0]?.reason).toBe("capacity");
    yield* hub.replication.replayHeld;
    expect(yield* hub.replication.discardQuarantined(threadId)).toBe(1000);
    expect(yield* hub.replication.discardQuarantined(threadId)).toBe(0);
    expect(
      (yield* hub.projections.getThreadProjection(threadId)).messages.map((m) => m.text),
    ).toEqual(["kept"]);
    const cursor = (yield* hub.replication.cursors(peer.environmentId)).received;
    yield* hub.replication.receive(
      {
        ...batch,
        after: cursor,
        cursor: { ...cursor, events: cursor.events + 1 },
        events: [encodeEvent(message("event:after-discard", at, "new"))],
      },
      peer.environmentId,
      false,
    );
    expect(
      (yield* hub.projections.getThreadProjection(threadId)).messages.map((m) => m.text),
    ).toEqual(expect.arrayContaining(["kept", "new"]));
  }).pipe(Effect.scoped),
);

it.live("a slow peer link keeps batches full instead of shrinking them to one event", () =>
  Effect.gen(function* () {
    const hub = yield* start("latency-hub", "cloud-server");
    const laptop = yield* start("latency-laptop", "computer");
    yield* pair(hub, laptop);
    const at = yield* DateTime.now;
    const stored = yield* laptop.sink.write({
      events: [
        thread("event:latency", at),
        ...Array.from({ length: 120 }, (_, i) => message(`event:latency:${i}`, at, `M${i}`)),
      ],
    });
    // Each apply on the far side takes as long as a remote round trip does.
    const original = hub.sink.writeReplica;
    const applied: Array<number> = [];
    const spy = vi
      .spyOn(hub.sink, "writeReplica")
      .mockImplementation((input) =>
        Effect.sleep("30 millis").pipe(
          Effect.andThen(Effect.sync(() => applied.push(input.events.length))),
          Effect.andThen(original(input)),
        ),
      );
    try {
      yield* laptop.sync.syncThrough(hub.environmentId, stored.at(-1)!.sequence);
      expect(yield* hub.replication.eventCount(threadId)).toBe(121);
      // Only the byte budget bounds a batch; a halving per slow trip took ~60.
      expect(applied.length).toBeLessThanOrEqual(8);
      expect(Math.min(...applied.slice(0, -1))).toBeGreaterThan(8);
    } finally {
      spy.mockRestore();
    }
  }),
);

it.live("priority receive waits for the bulk replay permit", () =>
  Effect.gen(function* () {
    const hub = yield* start("permit-hub", "cloud-server");
    const peer = yield* start("permit-peer", "computer");
    yield* pair(hub, peer);
    yield* peer.sink.write({ events: [thread("event:permit", yield* DateTime.now)] });
    const batch = yield* peer.replication.readBatch(
      { events: 0, meta: 0 },
      hub.environmentId,
      true,
    );
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const original = hub.sink.writeReplica;
    let calls = 0;
    const spy = vi.spyOn(hub.sink, "writeReplica").mockImplementation((input) =>
      Effect.gen(function* () {
        calls++;
        if (calls === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return yield* original(input);
      }),
    );
    try {
      const bulk = yield* hub.replication
        .receive(batch, peer.environmentId, false)
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const priority = yield* hub.replication
        .receivePriority(threadId, batch, peer.environmentId, false)
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(bulk);
      yield* Fiber.join(priority);
      expect(calls).toBe(1);
      expect(yield* hub.replication.eventCount(threadId)).toBe(1);
      expect(yield* hub.sql`SELECT 1 FROM thread_replication_deferred`).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }).pipe(Effect.scoped),
);

it.live("quarantine byte retention is bounded and version skew cannot be discarded", () =>
  Effect.gen(function* () {
    const hub = yield* start("bytes-hub", "cloud-server");
    const peer = yield* start("bytes-peer", "computer");
    yield* pair(hub, peer);
    const at = yield* DateTime.now;
    yield* peer.sink.write({ events: [thread("event:bytes", at)] });
    const batch = yield* peer.replication.readBatch(
      { events: 0, meta: 0 },
      hub.environmentId,
      true,
    );
    yield* hub.sql`INSERT INTO thread_replication_deferred(thread_id,item_kind,source_env,trusted_relay,item_json,reason)
      VALUES (${threadId},'event',${peer.environmentId},0,'{}','invalid-batch')`;
    const events = [1, 2].map((i) => ({
      ...(encodeEvent(message(`event:large:${i}`, at, "held")) as object),
      future: "x".repeat(9 * 1024 * 1024),
    }));
    yield* hub.replication.receive({ ...batch, events }, peer.environmentId, false);
    const rows = yield* hub.sql<{
      bytes: number;
      n: number;
    }>`SELECT SUM(length(CAST(item_json AS BLOB))) AS bytes,
      COUNT(*) AS n FROM thread_replication_deferred`;
    expect(rows[0]?.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(rows[0]?.n).toBe(1);
    yield* hub.sql`INSERT INTO thread_replication_deferred(thread_id,item_kind,source_env,trusted_relay,item_json)
      VALUES ('future-thread','event',${peer.environmentId},0,'{}')`;
    expect(yield* hub.replication.discardQuarantined("future-thread")).toBe(0);
    expect(
      (yield* hub.sql`SELECT 1 FROM thread_replication_deferred WHERE thread_id = 'future-thread'`)
        .length,
    ).toBe(1);
  }).pipe(Effect.scoped),
);
