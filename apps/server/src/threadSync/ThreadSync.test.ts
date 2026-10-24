import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  ThreadReplicationApply,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Machines from "../machines/Machines.ts";
import { pair, startMachine } from "../machines/testkit.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadSync from "./ThreadSync.ts";

const start = Effect.fn("startThreadSyncMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
) {
  const machine = yield* startMachine(name, role);
  const stores = yield* machine.run(
    Layer.build(
      EventSink.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer)),
      ),
    ),
  );
  const inStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    machine.run(Effect.provideContext(effect, stores as never));
  const replicationContext = yield* inStores(Layer.build(ThreadReplication.layer));
  const replication = yield* ThreadReplication.ThreadReplication.pipe(
    Effect.provideContext(replicationContext),
  );
  // Explicit passes in tests: no live change stream, no scheduler sleeps.
  const syncContext = yield* machine.run(
    Layer.build(
      ThreadSync.layer.pipe(
        Layer.provide(
          Layer.succeed(ThreadReplication.ThreadReplication, {
            ...replication,
            changes: Stream.never,
          }),
        ),
        Layer.provide(
          Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
        ),
        Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
      ),
    ),
  );
  const sync = yield* ThreadSync.ThreadSync.pipe(Effect.provideContext(syncContext));
  const sink = yield* inStores(EventSink.EventSinkV2);
  const projections = yield* inStores(Projections.ProjectionStoreV2);
  const sql = yield* machine.run(SqlClient.SqlClient);
  return { ...machine, replication, sync, sink, projections, sql };
});

const threadId = ThreadId.make("thread:on-laptop");
const thread = (
  id: string,
  at: DateTime.Utc,
  title = "On the laptop",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "thread.created",
  threadId,
  occurredAt: at,
  payload: { ...idleThreadProjection(liveThreadShell(threadId)).thread, title },
});
const message = (id: string, at: DateTime.Utc, text: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "message.updated",
  threadId,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(`message:${id}`),
    threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
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
