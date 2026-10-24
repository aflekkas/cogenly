/**
 * ThreadReplication: copies thread event logs between paired machines. Each
 * thread has one owner, the only machine that appends its events; others
 * keep a replica written through the normal event sink, so projections, the
 * thread list and live thread streams follow the owner unchanged. See
 * docs/internals/thread-sync.md.
 */
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  ProjectId,
  ProjectLabelId,
  THREAD_REPLICATION_BATCH_BYTES,
  THREAD_REPLICATION_BATCH_EVENTS,
  ThreadId,
  ThreadReplicaSource,
  type ThreadReplicaMeta,
  type ThreadReplicationBatch,
  type ThreadReplicationCursor,
  ThreadReplicationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import { REPLICA_COMMAND_PREFIX } from "../orchestration-v2/ReplayedCommandIds.ts";

export interface ThreadOwnerRecord {
  readonly threadId: ThreadId;
  readonly owner: EnvironmentId;
  readonly local: boolean;
  readonly epoch: number;
  readonly handoff: string | null;
}

export class ThreadReplication extends Context.Service<
  ThreadReplication,
  {
    readonly environmentId: EnvironmentId;
    /** The recorded owner; undefined for a thread created here and never handed off. */
    readonly owner: (threadId: ThreadId) => Effect.Effect<ThreadOwnerRecord | undefined>;
    /** Owners of threads another machine runs, for the thread list. */
    readonly remoteOwners: Effect.Effect<ReadonlyMap<ThreadId, EnvironmentId>>;
    /**
     * The next batch for `target`. A spoke sends only threads it owns; the hub
     * relays every thread `target` does not own.
     */
    readonly readBatch: (
      after: ThreadReplicationCursor,
      target: EnvironmentId,
      localOnly: boolean,
    ) => Effect.Effect<ThreadReplicationBatch, ThreadReplicationError>;
    /** trustedRelay is true only for this spoke's pinned hub. */
    readonly receive: (
      batch: ThreadReplicationBatch,
      source: EnvironmentId,
      trustedRelay: boolean,
    ) => Effect.Effect<{ readonly acknowledged: ThreadReplicationCursor }, ThreadReplicationError>;
    readonly cursors: (peer: EnvironmentId) => Effect.Effect<
      {
        readonly received: ThreadReplicationCursor;
        readonly acknowledged: ThreadReplicationCursor;
      },
      ThreadReplicationError
    >;
    readonly acknowledge: (
      peer: EnvironmentId,
      cursor: ThreadReplicationCursor,
    ) => Effect.Effect<void, ThreadReplicationError>;
    /** Fires after local thread events or metadata change. */
    readonly changes: Stream.Stream<void>;
  }
>()("cogenly-server/threadSync/ThreadReplication") {}

const storage = (cause: unknown) =>
  Schema.is(ThreadReplicationError)(cause)
    ? cause
    : new ThreadReplicationError({ reason: "storage", cause });
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2DomainEventJson));
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadReplicaSource));
const encodeSource = Schema.encodeSync(Schema.fromJsonString(ThreadReplicaSource));
const isCursor = (value: number, latest: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= latest;

interface OwnerRow {
  readonly thread_id: string;
  readonly owner_env: string;
  readonly local: number;
  readonly epoch: number;
  readonly handoff_json: string | null;
  readonly source_json: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const eventStore = yield* EventStore.EventStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  // ManagedProjectFolders keeps "No project" here; its project id differs per machine.
  const scratchRoot = path.resolve(config.baseDir, "scratch");

  const ownerRows = (threadIds: ReadonlyArray<string>) =>
    threadIds.length === 0
      ? Effect.succeed(new Map<string, OwnerRow>())
      : sql<OwnerRow>`SELECT * FROM thread_owners WHERE thread_id IN ${sql.in(threadIds)}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.thread_id, row]))),
        );

  const toRecord = (row: OwnerRow): ThreadOwnerRecord => ({
    threadId: ThreadId.make(row.thread_id),
    owner: EnvironmentId.make(row.owner_env),
    local: row.local === 1,
    epoch: row.epoch,
    handoff: row.handoff_json,
  });

  const owner: ThreadReplication["Service"]["owner"] = (threadId) =>
    ownerRows([threadId]).pipe(
      Effect.map((rows) => {
        const row = rows.get(threadId);
        return row === undefined ? undefined : toRecord(row);
      }),
      Effect.orDie,
    );

  const remoteOwners: ThreadReplication["Service"]["remoteOwners"] = sql<{
    readonly thread_id: string;
    readonly owner_env: string;
  }>`SELECT thread_id, owner_env FROM thread_owners WHERE local = 0`.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.map((row) => [ThreadId.make(row.thread_id), EnvironmentId.make(row.owner_env)]),
        ),
    ),
    Effect.orDie,
  );

  // Where this machine runs the thread, in terms another machine can map.
  const localSource = Effect.fn("ThreadReplication.localSource")(function* (threadId: string) {
    const rows = yield* sql<{
      readonly project_id: string;
      readonly workspace_root: string | null;
      readonly remote: string | null;
    }>`SELECT t.project_id, p.workspace_root,
        COALESCE(
          (SELECT r.remote FROM label_repositories r WHERE r.repository_id = t.project_id AND r.remote IS NOT NULL LIMIT 1),
          (SELECT c.remote FROM shared_repository_checkouts c WHERE c.repository_id = t.project_id LIMIT 1)
        ) AS remote
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId}`;
    const row = rows[0];
    if (row === undefined) return null;
    const projectId = ProjectId.make(row.project_id);
    if (row.workspace_root !== null && path.resolve(row.workspace_root) === scratchRoot)
      return { projectId, kind: "scratch", remote: null } satisfies ThreadReplicaSource;
    const repository = { projectId, kind: "repository" as const, remote: row.remote };
    // A remote the shared schema refuses (a local path, say) stays local-only.
    return Schema.is(ThreadReplicaSource)(repository) && row.remote !== null
      ? repository
      : ({ projectId, kind: "local", remote: null } satisfies ThreadReplicaSource);
  });

  const metaFor = Effect.fn("ThreadReplication.metaFor")(function* (
    threadId: string,
    row: OwnerRow | undefined,
  ) {
    const folder = yield* sql<{
      readonly folder_id: string | null;
    }>`SELECT folder_id FROM effective_thread_project_folders WHERE thread_id = ${threadId} LIMIT 1`;
    const source =
      row !== undefined && row.local === 0
        ? row.source_json === null
          ? null
          : yield* decodeSource(row.source_json).pipe(Effect.orElseSucceed(() => null))
        : yield* localSource(threadId);
    return {
      threadId: ThreadId.make(threadId),
      owner: row === undefined ? environmentId : EnvironmentId.make(row.owner_env),
      epoch: row?.epoch ?? 0,
      folderId: folder[0]?.folder_id ? ProjectLabelId.make(folder[0].folder_id) : null,
      source,
    } satisfies ThreadReplicaMeta;
  });

  const sendable = (target: EnvironmentId, localOnly: boolean) => (row: OwnerRow | undefined) =>
    localOnly ? row === undefined || row.local === 1 : row?.owner_env !== target;

  const readBatch: ThreadReplication["Service"]["readBatch"] = Effect.fn(
    "ThreadReplication.readBatch",
  )(function* (after, target, localOnly) {
    const latest = (yield* sql<{
      readonly events: number;
      readonly meta: number;
    }>`SELECT
        (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) AS events,
        (SELECT COALESCE(MAX(seq), 0) FROM thread_replication_meta_log) AS meta`)[0]!;
    if (!isCursor(after.events, latest.events) || !isCursor(after.meta, latest.meta))
      return yield* new ThreadReplicationError({ reason: "invalid-cursor" });
    // Filter by owner in SQL so a spoke full of replicas does not decode them to skip them.
    const ownerFilter = localOnly
      ? sql`NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = e.stream_id AND o.local = 0)`
      : sql`NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = e.stream_id AND o.owner_env = ${target})`;
    const candidates = yield* sql<{ readonly sequence: number }>`
      SELECT e.sequence FROM orchestration_events e
      WHERE e.sequence > ${after.events} AND e.sequence <= ${latest.events}
        AND e.aggregate_kind = 'thread' AND e.application_event_version = 2
        AND ${ownerFilter}
      ORDER BY e.sequence LIMIT ${THREAD_REPLICATION_BATCH_EVENTS}`;
    const wanted = new Set(candidates.map((row) => row.sequence));
    // Fewer candidates than the limit: everything up to `latest` was examined.
    let eventsCursor =
      candidates.length < THREAD_REPLICATION_BATCH_EVENTS
        ? latest.events
        : candidates.at(-1)!.sequence;
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (candidates.length > 0) {
      const stored = yield* Stream.runCollect(
        eventStore.read({
          afterSequence: candidates[0]!.sequence - 1,
          throughSequence: candidates.at(-1)!.sequence,
        }),
      );
      let bytes = 0;
      for (const item of stored) {
        if (!wanted.has(item.sequence)) continue;
        const size = Buffer.byteLength(yield* encodeEvent(item.event), "utf8");
        if (events.length > 0 && bytes + size > THREAD_REPLICATION_BATCH_BYTES - 16 * 1024) {
          eventsCursor = item.sequence - 1;
          break;
        }
        events.push(item.event);
        bytes += size;
      }
    }
    const metaRows = yield* sql<{
      readonly seq: number;
      readonly thread_id: string;
    }>`SELECT seq, thread_id FROM thread_replication_meta_log WHERE seq > ${after.meta} AND seq <= ${latest.meta} ORDER BY seq LIMIT ${THREAD_REPLICATION_BATCH_EVENTS}`;
    const metaCursor =
      metaRows.length < THREAD_REPLICATION_BATCH_EVENTS ? latest.meta : metaRows.at(-1)!.seq;
    const threadIds = [
      ...new Set([
        ...events.map((event) => event.threadId),
        ...metaRows.map((row) => row.thread_id),
      ]),
    ];
    const owners = yield* ownerRows(threadIds);
    const include = sendable(target, localOnly);
    const meta = yield* Effect.forEach(
      threadIds.filter((threadId) => include(owners.get(threadId))),
      (threadId) => metaFor(threadId, owners.get(threadId)),
    );
    return {
      after,
      cursor: { events: eventsCursor, meta: metaCursor },
      events,
      meta,
    } satisfies ThreadReplicationBatch;
  }, Effect.mapError(storage));

  const cursors: ThreadReplication["Service"]["cursors"] = Effect.fn("ThreadReplication.cursors")(
    function* (peer) {
      const row = (yield* sql<{
        readonly received_events: number;
        readonly received_meta: number;
        readonly acknowledged_events: number;
        readonly acknowledged_meta: number;
      }>`SELECT * FROM thread_replication_cursors WHERE environment_id = ${peer}`)[0];
      return {
        received: { events: row?.received_events ?? 0, meta: row?.received_meta ?? 0 },
        acknowledged: { events: row?.acknowledged_events ?? 0, meta: row?.acknowledged_meta ?? 0 },
      };
    },
    Effect.mapError(storage),
  );

  // Project ids are local; map the owner's checkout to this machine's copy of it.
  const localProject = Effect.fn("ThreadReplication.localProject")(function* (
    source: ThreadReplicaSource | null,
  ) {
    if (source === null) return undefined;
    const rows =
      source.kind === "scratch"
        ? yield* sql<{
            readonly project_id: string;
          }>`SELECT project_id FROM projection_projects WHERE workspace_root = ${scratchRoot} AND deleted_at IS NULL LIMIT 1`
        : source.remote === null
          ? []
          : yield* sql<{
              readonly project_id: string;
            }>`SELECT p.project_id FROM projection_projects p
              WHERE p.deleted_at IS NULL AND (
                EXISTS (SELECT 1 FROM shared_repository_checkouts c WHERE c.repository_id = p.project_id AND c.remote = ${source.remote})
                OR EXISTS (SELECT 1 FROM label_repositories r WHERE r.repository_id = p.project_id AND r.remote = ${source.remote}))
              LIMIT 1`;
    return rows[0] === undefined ? undefined : ProjectId.make(rows[0].project_id);
  });

  const receive: ThreadReplication["Service"]["receive"] = Effect.fn("ThreadReplication.receive")(
    function* (batch, source, trustedRelay) {
      const previous = (yield* cursors(source)).received;
      if (
        batch.cursor.events < batch.after.events ||
        batch.cursor.meta < batch.after.meta ||
        batch.after.events > previous.events ||
        batch.after.meta > previous.meta
      )
        return yield* new ThreadReplicationError({ reason: "invalid-cursor" });
      if (batch.cursor.events <= previous.events && batch.cursor.meta <= previous.meta)
        return { acknowledged: previous };
      const metaByThread = new Map(batch.meta.map((meta) => [meta.threadId, meta]));
      for (const event of batch.events)
        if (!metaByThread.has(event.threadId))
          return yield* new ThreadReplicationError({ reason: "invalid-batch" });
      for (const meta of batch.meta)
        if (!trustedRelay && meta.owner !== source)
          return yield* new ThreadReplicationError({ reason: "invalid-batch" });

      const owners = yield* ownerRows([...metaByThread.keys()]);
      const present = new Set(
        (metaByThread.size === 0
          ? []
          : yield* sql<{
              readonly thread_id: string;
            }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in([...metaByThread.keys()])}`
        ).map((row) => row.thread_id),
      );
      const accepted = new Map<ThreadId, { meta: ThreadReplicaMeta; projectId?: ProjectId }>();
      for (const meta of batch.meta) {
        const row = owners.get(meta.threadId);
        // Handing a thread to this machine is the handoff protocol's decision, never a replica's.
        if (meta.owner === environmentId) continue;
        if (row === undefined ? present.has(meta.threadId) : row.local === 1) {
          yield* Effect.logWarning("Skipping a replicated thread this machine also runs", {
            threadId: meta.threadId,
            owner: meta.owner,
          });
          continue;
        }
        if (row !== undefined && meta.epoch < row.epoch) continue;
        if (row !== undefined && meta.epoch === row.epoch && meta.owner !== row.owner_env) {
          yield* Effect.logWarning("Skipping a conflicting thread owner", {
            threadId: meta.threadId,
          });
          continue;
        }
        const projectId = yield* localProject(meta.source);
        accepted.set(meta.threadId, { meta, ...(projectId === undefined ? {} : { projectId }) });
      }

      // Owners first: a crash after this leaves an empty replica, never a thread
      // whose events look like this machine's own.
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.forEach(
          accepted.values(),
          ({ meta }) =>
            sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, source_json, updated_at)
              VALUES (${meta.threadId}, ${meta.owner}, 0, ${meta.epoch}, ${meta.source === null ? null : encodeSource(meta.source)}, ${now})
              ON CONFLICT(thread_id) DO UPDATE SET owner_env = excluded.owner_env, epoch = excluded.epoch,
                source_json = excluded.source_json, updated_at = excluded.updated_at
              WHERE thread_owners.local = 0`,
          { discard: true },
        ),
      );

      const candidates = batch.events.filter((event) => accepted.has(event.threadId));
      const stored = new Set(
        candidates.length === 0
          ? []
          : (yield* sql<{
              readonly event_id: string;
            }>`SELECT event_id FROM orchestration_events WHERE event_id IN ${sql.in(candidates.map((event) => event.id))}`).map(
              (row) => row.event_id,
            ),
      );
      const fresh = candidates
        .filter((event) => !stored.has(event.id))
        .map((event) => {
          const projectId = accepted.get(event.threadId)?.projectId;
          return projectId !== undefined &&
            event.type.startsWith("thread.") &&
            "projectId" in event.payload
            ? ({ ...event, payload: { ...event.payload, projectId } } as OrchestrationV2DomainEvent)
            : event;
        });
      if (fresh.length > 0) {
        const commandId = CommandId.make(
          `${REPLICA_COMMAND_PREFIX}${source}:${batch.cursor.events}`,
        );
        // One event that cannot apply here must not wedge the cursor for the rest.
        yield* eventSink.write({ commandId, events: fresh }).pipe(
          Effect.catch(() =>
            Effect.forEach(
              fresh,
              (event) =>
                eventSink.write({ commandId, events: [event] }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Skipping a replicated event that does not apply", {
                      eventId: event.id,
                      threadId: event.threadId,
                      error: error.message,
                    }),
                  ),
                ),
              { discard: true },
            ),
          ),
        );
      }

      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const { meta } of accepted.values()) {
            const filed = yield* sql<{
              readonly label_id: string;
            }>`SELECT label_id FROM thread_project_labels WHERE thread_id = ${meta.threadId}`;
            if ((filed[0]?.label_id ?? null) === meta.folderId) continue;
            yield* sql`DELETE FROM thread_project_labels WHERE thread_id = ${meta.threadId}`;
            if (meta.folderId !== null)
              yield* sql`INSERT INTO thread_project_labels(thread_id, label_id)
                SELECT ${meta.threadId}, label_id FROM project_labels WHERE label_id = ${meta.folderId}`;
          }
          yield* sql`INSERT INTO thread_replication_cursors(environment_id, received_events, received_meta)
            VALUES (${source}, ${batch.cursor.events}, ${batch.cursor.meta})
            ON CONFLICT(environment_id) DO UPDATE SET received_events = excluded.received_events,
              received_meta = excluded.received_meta`;
        }),
      );
      return { acknowledged: batch.cursor };
    },
    Effect.mapError(storage),
  );

  const acknowledge: ThreadReplication["Service"]["acknowledge"] = Effect.fn(
    "ThreadReplication.acknowledge",
  )(function* (peer, cursor) {
    const latest = (yield* sql<{
      readonly events: number;
      readonly meta: number;
    }>`SELECT
        (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) AS events,
        (SELECT COALESCE(MAX(seq), 0) FROM thread_replication_meta_log) AS meta`)[0]!;
    if (!isCursor(cursor.events, latest.events) || !isCursor(cursor.meta, latest.meta))
      return yield* new ThreadReplicationError({ reason: "invalid-cursor" });
    yield* sql`INSERT INTO thread_replication_cursors(environment_id, acknowledged_events, acknowledged_meta)
      VALUES (${peer}, ${cursor.events}, ${cursor.meta})
      ON CONFLICT(environment_id) DO UPDATE SET
        acknowledged_events = max(acknowledged_events, excluded.acknowledged_events),
        acknowledged_meta = max(acknowledged_meta, excluded.acknowledged_meta)`;
  }, Effect.mapError(storage));

  const changes: ThreadReplication["Service"]["changes"] = Stream.unwrap(
    eventSink
      .latestSequence()
      .pipe(Effect.map((latest) => eventSink.stream({ afterSequence: latest }))),
  ).pipe(
    Stream.as(undefined),
    Stream.catch(() => Stream.empty),
  );

  return ThreadReplication.of({
    environmentId,
    owner,
    remoteOwners,
    readBatch,
    receive,
    cursors,
    acknowledge,
    changes,
  });
});

export const layer = Layer.effect(ThreadReplication, make);
