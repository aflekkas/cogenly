import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { pair } from "../machines/testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { startThreadMachine as start, threadCreated } from "./testkit.ts";

const shared = ProviderSessionId.make("provider-session:provider-instance:codex:shared");
const scoped = (origin: string, id: ThreadId, sessionId = shared) =>
  `${sessionId}:machine:${encodeURIComponent(origin)}:thread:${encodeURIComponent(id)}`;

const history = (
  id: ThreadId,
  at: DateTime.Utc,
  sessionId = shared,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const created = threadCreated(`event:${id}:created`, at);
  const base = { threadId: id, occurredAt: at };
  const events: Array<OrchestrationV2DomainEvent> = [
    { ...created, threadId: id, payload: { ...created.payload, id } } as OrchestrationV2DomainEvent,
    {
      ...base,
      id: EventId.make(`event:${id}:session`),
      type: "provider-session.attached",
      payload: {
        id: sessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make(sessionId.split(":")[2]!),
        status: "ready",
        cwd: "/shared",
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: at,
        updatedAt: at,
        lastError: null,
      },
    },
    {
      ...base,
      id: EventId.make(`event:${id}:provider-thread`),
      type: "provider-thread.updated",
      payload: {
        id: ProviderThreadId.make(`provider-thread:${id}`),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make(sessionId.split(":")[2]!),
        providerSessionId: sessionId,
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      ...base,
      id: EventId.make(`event:${id}:request`),
      type: "runtime-request.updated",
      payload: {
        id: RuntimeRequestId.make(`request:${id}`),
        nodeId: NodeId.make(`node:${id}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: at,
        resolvedAt: at,
      },
    },
    {
      ...base,
      id: EventId.make(`event:${id}:detached`),
      type: "provider-session.detached",
      payload: { providerSessionId: sessionId, detachedAt: at, reason: sessionId },
    },
  ];
  const attached = events[1]!;
  if (attached.type === "provider-session.attached") {
    events.splice(2, 0, {
      ...attached,
      id: EventId.make(`event:${id}:session-updated`),
      type: "provider-session.updated",
    });
  }
  return events;
};

it.live.each(["codex", "codex-work"])(
  "populated peers resume legacy %s batches in both directions without changing local history",
  (instance) =>
    Effect.gen(function* () {
      const hub = yield* start("legacy-hub", "cloud-server");
      const mac = yield* start("legacy-mac", "computer");
      yield* pair(hub, mac);
      const at = yield* DateTime.now;
      const legacySessionId = ProviderSessionId.make(
        `provider-session:provider-instance:${instance}:shared`,
      );
      const hubId = ThreadId.make("thread:hub-legacy");
      const macId = ThreadId.make("thread:mac-legacy");
      yield* hub.sink.write({ events: history(hubId, at, legacySessionId) });
      yield* mac.sink.write({ events: history(macId, at, legacySessionId) });
      for (const [source, target, id] of [
        [mac, hub, macId],
        [hub, mac, hubId],
      ] as const) {
        const batch = yield* source.replication.readBatch(
          { events: 0, meta: 0 },
          target.environmentId,
          true,
        );
        // v0.3.0 sends no origin annotation. Its rejected batch/cursor needs no repair.
        const oldBatch = {
          ...batch,
          events: batch.events.map((item) => {
            const { cogenlyReplicaSessionOrigin: _origin, ...raw } = item as Record<
              string,
              Schema.Json
            >;
            return raw;
          }),
        };
        yield* target.replication.receive(
          {
            ...oldBatch,
            cursor: { ...oldBatch.cursor, events: 1 },
            events: oldBatch.events.slice(0, 1),
          },
          source.environmentId,
          false,
        );
        expect((yield* target.replication.cursors(source.environmentId)).received.events).toBe(1);
        yield* target.replication.receive(oldBatch, source.environmentId, false);
        yield* target.replication.receive(oldBatch, source.environmentId, false);
        expect((yield* target.replication.cursors(source.environmentId)).received).toEqual(
          batch.cursor,
        );
        const projection = yield* target.projections.getThreadProjection(id);
        expect(
          (yield* target.sql`SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions
          WHERE provider_session_id = ${scoped(source.environmentId, id, legacySessionId)}`).length,
        ).toBe(1);
        expect(projection.providerThreads[0]?.providerSessionId).toBe(
          scoped(source.environmentId, id, legacySessionId),
        );
        expect(projection.runtimeRequests[0]?.responseCapability).toEqual({
          type: "live",
          providerSessionId: scoped(source.environmentId, id, legacySessionId),
        });
        const events = yield* target.sql<{
          event_id: string;
        }>`SELECT event_id FROM orchestration_events WHERE stream_id = ${id} ORDER BY sequence`;
        expect(events.map((row) => row.event_id)).toEqual(
          history(id, at, legacySessionId).map((event) => event.id),
        );
        const detached = yield* target.sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id = ${`event:${id}:detached`}`;
        expect(JSON.parse(detached[0]!.payload_json)).toMatchObject({
          reason: legacySessionId,
          providerSessionId: scoped(source.environmentId, id, legacySessionId),
        });
      }
      for (const machine of [hub, mac]) {
        expect(
          (yield* machine.sql`SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions
          WHERE provider_session_id = ${legacySessionId}`).length,
        ).toBe(1);
      }
    }).pipe(Effect.scoped),
);

it.live(
  "legacy session provenance survives relay, handoff and replay with split thread owners",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("legacy-relay", "cloud-server");
      const mac = yield* start("legacy-origin", "computer");
      const other = yield* start("legacy-other", "computer");
      yield* pair(hub, mac);
      yield* pair(hub, other);
      const at = yield* DateTime.now;
      const moved = ThreadId.make("thread:legacy-moved");
      const stays = ThreadId.make("thread:legacy-stays");
      const hubLocal = ThreadId.make("thread:legacy-hub-local");
      yield* hub.sink.write({ events: history(hubLocal, at) });
      yield* mac.sink.write({ events: [...history(moved, at), ...history(stays, at)] });
      for (const machine of [mac, hub]) {
        yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
          VALUES ('project:mcp-test', 'Project', '/repo', 0, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
      }
      yield* mac.sync.sync(hub.environmentId);
      expect(
        (yield* mac.transfer.move({ threadIds: [moved], target: hub.environmentId })).moved,
      ).toEqual([moved]);
      expect(
        yield* hub.transfer.move({ threadIds: [hubLocal], target: mac.environmentId }),
      ).toMatchObject({ moved: [hubLocal], skipped: [] });
      yield* hub.sync.sync(other.environmentId);
      expect(
        (yield* other.sql`SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions
        WHERE provider_session_id = ${scoped(hub.environmentId, hubLocal)}`).length,
      ).toBe(1);
      for (const id of [moved, stays]) {
        expect(
          (yield* other.sql`SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions
          WHERE provider_session_id = ${scoped(mac.environmentId, id)}`).length,
        ).toBe(1);
      }
      const batch = yield* hub.replication.readBatch(
        { events: 0, meta: 0 },
        other.environmentId,
        false,
      );
      expect(batch.events).toContainEqual(
        expect.objectContaining({
          id: `event:${moved}:session`,
          cogenlyReplicaSessionOrigin: mac.environmentId,
          payload: expect.objectContaining({ id: shared }),
        }),
      );
      yield* other.replication.receive(batch, hub.environmentId, true);
      expect((yield* other.sql`SELECT event_id FROM orchestration_events`).length).toBe(18);
    }).pipe(Effect.scoped),
);

it.live("a peer still cannot claim another thread's machine-scoped session", () =>
  Effect.gen(function* () {
    const hub = yield* start("legacy-conflict-hub", "cloud-server");
    const mac = yield* start("legacy-conflict-mac", "computer");
    yield* pair(hub, mac);
    const at = yield* DateTime.now;
    const local = ThreadId.make("thread:local-session");
    const remote = ThreadId.make("thread:conflicting-session");
    const sessionId = ProviderSessionId.make(
      `${shared}:machine:${encodeURIComponent(hub.environmentId)}`,
    );
    yield* hub.sink.write({ events: history(local, at, sessionId) });
    yield* mac.sink.write({ events: history(remote, at, sessionId) });
    const batch = yield* mac.replication.readBatch({ events: 0, meta: 0 }, hub.environmentId, true);
    const failure = yield* Effect.flip(hub.replication.receive(batch, mac.environmentId, false));
    expect(failure).toMatchObject({
      cause: { cause: expect.any(EventSink.ThreadOwnedElsewhereError) },
    });
    expect((yield* hub.replication.cursors(mac.environmentId)).received.events).toBe(0);
    expect(
      (yield* hub.sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${remote}`)
        .length,
    ).toBe(0);
  }).pipe(Effect.scoped),
);

it.live("machine-scoped sessions can reattach after a sibling thread moves to the hub", () =>
  Effect.gen(function* () {
    const hub = yield* start("machine-handoff-hub", "cloud-server");
    const mac = yield* start("machine-handoff-mac", "computer");
    yield* pair(hub, mac);
    const at = yield* DateTime.now;
    const moved = ThreadId.make("thread:machine-moved");
    const stays = ThreadId.make("thread:machine-stays");
    const sessionId = ProviderSessionId.make(
      `${shared}:machine:${encodeURIComponent(mac.environmentId)}`,
    );
    // Attach T1 last so the shared session row points at the thread we move.
    yield* mac.sink.write({
      events: [...history(stays, at, sessionId), ...history(moved, at, sessionId)],
    });
    for (const machine of [mac, hub]) {
      yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
        VALUES ('project:mcp-test', 'Project', '/repo', 0, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
    }
    yield* mac.sync.sync(hub.environmentId);
    expect(
      (yield* mac.transfer.move({ threadIds: [moved], target: hub.environmentId })).moved,
    ).toEqual([moved]);
    expect(
      (yield* hub.sql`SELECT 1 FROM orchestration_v2_projection_provider_session_bindings
      WHERE provider_session_id = ${sessionId} AND thread_id = ${stays}`).length,
    ).toBe(0);
    const attached = history(stays, at, sessionId)[1]!;
    yield* mac.sink.write({
      events: [{ ...attached, id: EventId.make("event:machine-reattach") }],
    });
    yield* mac.sync.sync(hub.environmentId);
    yield* hub.sync.sync(mac.environmentId);
    expect(
      (yield* hub.projections.getThreadProjection(stays)).providerSessions.map(
        (session) => session.id,
      ),
    ).toContain(sessionId);
    expect((yield* hub.replication.cursors(mac.environmentId)).received).toEqual(
      (yield* mac.replication.cursors(hub.environmentId)).acknowledged,
    );
  }).pipe(Effect.scoped),
);

it.live("pre-fix replica history keeps its writer after handoff without an origin annotation", () =>
  Effect.gen(function* () {
    const hub = yield* start("old-provenance-hub", "cloud-server");
    const mac = yield* start("old-provenance-mac", "computer");
    const other = yield* start("old-provenance-other", "computer");
    yield* pair(hub, mac);
    yield* pair(hub, other);
    const at = yield* DateTime.now;
    const id = ThreadId.make("thread:old-provenance");
    // Simulate a batch accepted before normalization existed, then handed off.
    yield* hub.sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, updated_at)
      VALUES (${id}, ${mac.environmentId}, 0, 0, '2026-01-01T00:00:00Z')`;
    yield* hub.sink.writeReplica({
      commandId: CommandId.make(`command:replica:${mac.environmentId}:42`),
      events: history(id, at),
      owners: [{ threadId: id, owner: mac.environmentId, epoch: 0 }],
    });
    yield* hub.sql`UPDATE thread_owners SET owner_env = ${hub.environmentId}, local = 1, epoch = 1 WHERE thread_id = ${id}`;
    const batch = yield* hub.replication.readBatch(
      { events: 0, meta: 0 },
      other.environmentId,
      false,
    );
    expect(batch.events).toContainEqual(
      expect.objectContaining({
        id: `event:${id}:session`,
        cogenlyReplicaSessionOrigin: mac.environmentId,
      }),
    );
    // An older relay may send a replica receipt without the newer origin field.
    const oldWire = {
      ...batch,
      events: batch.events.map((raw) => {
        const { cogenlyReplicaSessionOrigin: _origin, ...event } = raw as Record<
          string,
          Schema.Json
        >;
        return {
          ...event,
          cogenlyReplicaReceipt: {
            commandId: `command:replica:${mac.environmentId}:42`,
            commandType: "thread.create",
            acceptedAt: DateTime.formatIso(at),
            status: "accepted",
            error: null,
          },
        };
      }),
    };
    yield* other.replication.receive(oldWire, hub.environmentId, true);
    expect(
      (yield* other.sql`SELECT 1 FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${scoped(mac.environmentId, id)}`).length,
    ).toBe(1);
  }).pipe(Effect.scoped),
);

it.live(
  "independent native imports keep separate provider threads and references through relay",
  () =>
    Effect.gen(function* () {
      const hub = yield* start("native-import-hub", "cloud-server");
      const mac = yield* start("native-import-mac", "computer");
      const other = yield* start("native-import-other", "computer");
      yield* pair(hub, mac);
      yield* pair(hub, other);
      const at = yield* DateTime.now;
      const nativeId = ProviderThreadId.make(
        "provider-thread:provider:codex:native-thread:imported-conversation",
      );
      const imported = (id: ThreadId) =>
        history(id, at).map((event) =>
          event.type === "provider-thread.updated"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  id: nativeId,
                  nativeThreadRef: {
                    driver: ProviderDriverKind.make("codex"),
                    nativeId: "imported-conversation",
                    strength: "strong" as const,
                  },
                },
              }
            : event.type === "thread.created"
              ? { ...event, payload: { ...event.payload, activeProviderThreadId: nativeId } }
              : event,
        );
      const hubId = ThreadId.make("import:codex:imported-conversation");
      const macId = ThreadId.make("thread:provider:codex:native-thread:imported-conversation");
      yield* hub.sink.write({ events: imported(hubId) });
      yield* mac.sink.write({ events: imported(macId) });
      yield* mac.sync.sync(hub.environmentId);
      yield* hub.sync.sync(mac.environmentId);
      yield* hub.sync.sync(other.environmentId);
      for (const [id, origin] of [
        [hubId, hub.environmentId],
        [macId, mac.environmentId],
      ] as const) {
        const projection = yield* other.projections.getThreadProjection(id);
        expect(projection.thread.activeProviderThreadId).toBe(
          `${nativeId}:machine:${encodeURIComponent(origin)}`,
        );
        expect(projection.providerThreads[0]).toMatchObject({
          id: projection.thread.activeProviderThreadId,
          appThreadId: id,
          nativeThreadRef: { nativeId: "imported-conversation" },
        });
      }
      expect((yield* hub.projections.getThreadProjection(hubId)).providerThreads[0]?.id).toBe(
        nativeId,
      );
    }).pipe(Effect.scoped),
);

it.live.each(["startup", "shutdown", "unrecognized"])(
  "%s recovery events from the wrong stream never overwrite another thread",
  (trigger) =>
    Effect.gen(function* () {
      const hub = yield* start(`misrouted-hub-${trigger}`, "cloud-server");
      const mac = yield* start(`misrouted-mac-${trigger}`, "computer");
      yield* pair(hub, mac);
      const at = yield* DateTime.now;
      const wrong = ThreadId.make("thread:wrong-recovery-stream");
      const actual = ThreadId.make("thread:actual-recovery-stream");
      yield* mac.sink.write({ events: [...history(wrong, at), ...history(actual, at)] });
      yield* mac.sync.sync(hub.environmentId);
      const providerThread = history(actual, at).find(
        (event) => event.type === "provider-thread.updated",
      )!;
      const command = `command:runtime-reconcile:${trigger}:${wrong}:2026-10-22T18:38:21.451Z`;
      const id = EventId.make(
        `event:thread:${encodeURIComponent(wrong)}:command:${encodeURIComponent(command)}:old-event`,
      );
      if (providerThread.type !== "provider-thread.updated")
        throw new Error("missing provider thread");
      yield* mac.sink.write({
        events: [
          {
            ...providerThread,
            id,
            threadId: wrong,
            payload: { ...providerThread.payload, status: "active" },
          },
        ],
      });
      const batch = yield* mac.replication.readBatch(
        (yield* hub.replication.cursors(mac.environmentId)).received,
        hub.environmentId,
        true,
      );
      if (trigger === "unrecognized") {
        expect(
          (yield* Effect.result(hub.replication.receive(batch, mac.environmentId, false)))._tag,
        ).toBe("Failure");
      } else {
        yield* hub.replication.receive(batch, mac.environmentId, false);
        expect(
          (yield* hub.sql`SELECT 1 FROM orchestration_events WHERE event_id = ${id}`).length,
        ).toBe(1);
      }
      expect((yield* hub.projections.getThreadProjection(actual)).providerThreads[0]?.status).toBe(
        "idle",
      );
      expect(
        (yield* hub.projections.getThreadProjection(wrong)).providerThreads[0]?.appThreadId,
      ).toBe(wrong);
    }).pipe(Effect.scoped),
);
