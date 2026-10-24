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
  ThreadReplicaMeta,
  type ThreadReplicationBatch,
  type ThreadReplicationCursor,
  ThreadReplicationError,
  ThreadRemoteError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
    /**
     * Start handing a thread this machine runs to `target`: refuses unless it
     * is idle, then fences local writes until finish or release. Returns the
     * epoch the target takes it at.
     */
    readonly fence: (
      threadId: ThreadId,
      target: EnvironmentId,
    ) => Effect.Effect<{ readonly epoch: number }, ThreadRemoteError>;
    /** Drop a fence the target refused; the thread runs here again. */
    readonly release: (threadId: ThreadId) => Effect.Effect<void>;
    /** The target took the thread: record it as the owner and drop the fence. */
    readonly finish: (threadId: ThreadId) => Effect.Effect<void>;
    /** Fenced threads, for retrying commits whose reply was lost. */
    readonly fenced: Effect.Effect<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly target: EnvironmentId;
        readonly epoch: number;
      }>
    >;
    /**
     * Take a replica from `from` at `epoch`. "already" when this machine took
     * it at that epoch before; fails when `from` does not own it here.
     */
    readonly take: (
      threadId: ThreadId,
      from: EnvironmentId,
      epoch: number,
    ) => Effect.Effect<"taken" | "already", ThreadRemoteError>;
    /** This machine's checkout of the project a replica runs in on its owner. */
    readonly sourceProject: (threadId: ThreadId) => Effect.Effect<{
      readonly source: ThreadReplicaSource | null;
      readonly projectId: ProjectId | undefined;
    }>;
  }
>()("cogenly-server/threadSync/ThreadReplication") {}

const isReplicationError = Schema.is(ThreadReplicationError);
const isPortableSource = Schema.is(ThreadReplicaSource);
const storage = (cause: unknown) =>
  isReplicationError(cause) ? cause : new ThreadReplicationError({ reason: "storage", cause });
const encodeEventJson = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const decodeEventJson = Schema.decodeUnknownOption(OrchestrationV2DomainEventJson);
const encodeMeta = Schema.encodeEffect(ThreadReplicaMeta);
const decodeMeta = Schema.decodeUnknownOption(ThreadReplicaMeta);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const rawField = (raw: unknown, key: string) =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)[key]
    : undefined;
const rawThreadId = (raw: unknown) => {
  const value = rawField(raw, "threadId");
  return typeof value === "string" ? value : undefined;
};
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadReplicaSource));
const encodeSource = Schema.encodeSync(Schema.fromJsonString(ThreadReplicaSource));
/** A pending handoff: the machine taking the thread and the epoch it takes it at. */
const HandoffJson = Schema.fromJsonString(
  Schema.Struct({ target: EnvironmentId, epoch: Schema.Number }),
);
const encodeHandoff = Schema.encodeSync(HandoffJson);
const decodeHandoff = Schema.decodeUnknownSync(HandoffJson);
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
    return isPortableSource(repository) && row.remote !== null
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
    const events: Array<Schema.Json> = [];
    const eventThreads: Array<ThreadId> = [];
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
        const encoded = (yield* encodeEventJson(item.event)) as Schema.Json;
        const size = Buffer.byteLength(encodeJson(encoded), "utf8");
        if (events.length > 0 && bytes + size > THREAD_REPLICATION_BATCH_BYTES - 16 * 1024) {
          eventsCursor = item.sequence - 1;
          break;
        }
        events.push(encoded);
        eventThreads.push(item.event.threadId);
        bytes += size;
      }
    }
    const metaRows = yield* sql<{
      readonly seq: number;
      readonly thread_id: string;
    }>`SELECT seq, thread_id FROM thread_replication_meta_log WHERE seq > ${after.meta} AND seq <= ${latest.meta} ORDER BY seq LIMIT ${THREAD_REPLICATION_BATCH_EVENTS}`;
    const metaCursor =
      metaRows.length < THREAD_REPLICATION_BATCH_EVENTS ? latest.meta : metaRows.at(-1)!.seq;
    const threadIds = [...new Set([...eventThreads, ...metaRows.map((row) => row.thread_id)])];
    const owners = yield* ownerRows(threadIds);
    const include = sendable(target, localOnly);
    const meta = yield* Effect.forEach(
      threadIds.filter((threadId) => include(owners.get(threadId))),
      (threadId) =>
        metaFor(threadId, owners.get(threadId)).pipe(
          Effect.flatMap(encodeMeta),
          Effect.map((encoded) => encoded as Schema.Json),
        ),
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

  /**
   * Applies decoded metadata and events from `source`: owners first, then the
   * events this machine lacks, then filing. Used by receive, and at startup
   * for items an older build of this machine held back.
   */
  const applyItems = Effect.fn("ThreadReplication.applyItems")(function* (
    metas: ReadonlyArray<ThreadReplicaMeta>,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    source: EnvironmentId,
    commandKey: string,
  ) {
    const metaByThread = new Map(metas.map((meta) => [meta.threadId, meta]));
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
    for (const meta of metas) {
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

    const candidates = events.filter((event) => accepted.has(event.threadId));
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
      const commandId = CommandId.make(`${REPLICA_COMMAND_PREFIX}${source}:${commandKey}`);
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
      }),
    );
  });

  /**
   * Decodes a batch item by item. A thread with an item this build cannot read,
   * or with items already held, is held whole and in order, so it never applies
   * out of sequence; every other thread applies now.
   */
  const splitBatch = Effect.fn("ThreadReplication.splitBatch")(function* (
    batch: ThreadReplicationBatch,
    source: EnvironmentId,
    trustedRelay: boolean,
  ) {
    const held = new Set(
      (yield* sql<{
        readonly thread_id: string;
      }>`SELECT DISTINCT thread_id FROM thread_replication_deferred`).map((row) => row.thread_id),
    );
    const metas = batch.meta.map((raw) => ({
      raw,
      threadId: rawThreadId(raw),
      decoded: decodeMeta(raw),
    }));
    const events = batch.events.map((raw) => ({
      raw,
      threadId: rawThreadId(raw),
      decoded: decodeEventJson(raw),
    }));
    // Shape checks that hold for every build: each item names its thread,
    // each event comes with its thread's metadata, and a peer speaks only
    // for threads it owns unless it is this spoke's hub.
    const metaThreads = new Set(metas.map((item) => item.threadId));
    for (const item of [...metas, ...events])
      if (item.threadId === undefined)
        return yield* new ThreadReplicationError({ reason: "invalid-batch" });
    for (const item of events)
      if (!metaThreads.has(item.threadId))
        return yield* new ThreadReplicationError({ reason: "invalid-batch" });
    for (const item of metas)
      if (!trustedRelay && rawField(item.raw, "owner") !== source)
        return yield* new ThreadReplicationError({ reason: "invalid-batch" });
    for (const item of metas) if (Option.isNone(item.decoded)) held.add(item.threadId!);
    for (const item of events) if (Option.isNone(item.decoded)) held.add(item.threadId!);
    const isHeld = (item: { readonly threadId: string | undefined }) => held.has(item.threadId!);
    return {
      deferred: [
        ...metas.filter(isHeld).map((item) => ({ kind: "meta" as const, ...item })),
        ...events.filter(isHeld).map((item) => ({ kind: "event" as const, ...item })),
      ],
      metas: metas.filter((item) => !isHeld(item)).flatMap((item) => Option.toArray(item.decoded)),
      events: events
        .filter((item) => !isHeld(item))
        .flatMap((item) => Option.toArray(item.decoded)),
    };
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
      const split = yield* splitBatch(batch, source, trustedRelay);
      if (split.deferred.length > 0) {
        yield* Effect.logWarning("Holding replicated threads this build cannot read yet", {
          threads: [...new Set(split.deferred.map((item) => item.threadId))],
        });
        for (const item of split.deferred)
          yield* sql`INSERT INTO thread_replication_deferred(thread_id, item_kind, source_env, trusted_relay, item_json)
            VALUES (${item.threadId!}, ${item.kind}, ${source}, ${trustedRelay ? 1 : 0}, ${encodeJson(item.raw)})`;
      }
      yield* applyItems(split.metas, split.events, source, `${batch.cursor.events}`);
      yield* sql`INSERT INTO thread_replication_cursors(environment_id, received_events, received_meta)
        VALUES (${source}, ${batch.cursor.events}, ${batch.cursor.meta})
        ON CONFLICT(environment_id) DO UPDATE SET received_events = excluded.received_events,
          received_meta = excluded.received_meta`;
      return { acknowledged: batch.cursor };
    },
    Effect.mapError(storage),
  );

  /**
   * After an update, applies held threads this build can now read, each in
   * its original order. A thread with any item still unreadable stays held.
   */
  const replayHeld = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly seq: number;
      readonly thread_id: string;
      readonly item_kind: "meta" | "event";
      readonly source_env: string;
      readonly item_json: string;
    }>`SELECT seq, thread_id, item_kind, source_env, item_json FROM thread_replication_deferred ORDER BY thread_id, seq`;
    const byThread = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows)
      byThread.set(row.thread_id, [...(byThread.get(row.thread_id) ?? []), row]);
    for (const [threadId, items] of byThread) {
      const decoded = items.map((row) => {
        const raw = decodeJsonOption(row.item_json);
        return {
          row,
          meta: row.item_kind === "meta" ? Option.flatMap(raw, decodeMeta) : Option.none(),
          event: row.item_kind === "event" ? Option.flatMap(raw, decodeEventJson) : Option.none(),
        };
      });
      // A row decodes to exactly one of the two; neither means still unreadable.
      if (decoded.some((item) => Option.isNone(item.meta) && Option.isNone(item.event))) continue;
      // Held items keep their sender; apply them in runs from one sender.
      let at = 0;
      while (at < decoded.length) {
        const sender = decoded[at]!.row.source_env;
        let end = at;
        while (end < decoded.length && decoded[end]!.row.source_env === sender) end++;
        const run = decoded.slice(at, end);
        yield* applyItems(
          run.flatMap((item) => Option.toArray(item.meta)),
          run.flatMap((item) => Option.toArray(item.event)),
          EnvironmentId.make(sender),
          `held:${run[0]!.row.seq}`,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Dropping held replicated items that no longer apply", {
              threadId,
              reason: error.reason,
            }),
          ),
        );
        at = end;
      }
      yield* sql`DELETE FROM thread_replication_deferred WHERE thread_id = ${threadId}`;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not replay held replicated threads", { cause }),
    ),
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

  // Work that would run, or answer, on this machine after the fence.
  const busyReason = (threadId: ThreadId) =>
    sql<{ readonly busy: string | null }>`SELECT CASE
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
          AND status IN ('queued','preparing','starting','running','waiting')) THEN 'It has a turn running or queued.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId}
          AND status IN ('pending','waiting')) THEN 'It is waiting for an answer.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}
          AND status IN ('pending','starting','running','waiting')) THEN 'A subagent is still working.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
          AND status IN ('pending','running')) THEN 'It is still finishing its last turn.'
        ELSE NULL END AS busy`.pipe(Effect.map((rows) => rows[0]?.busy ?? null));

  const fence: ThreadReplication["Service"]["fence"] = (threadId, target) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* ownerRows([threadId])).get(threadId);
          if (row !== undefined && row.local === 0)
            return yield* new ThreadRemoteError({ reason: "not-owner" });
          if (row?.handoff_json != null)
            return yield* new ThreadRemoteError({
              reason: "moving",
              detail: "This thread is already moving to another machine.",
            });
          const present = yield* sql<{
            readonly thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`;
          if (present.length === 0)
            return yield* new ThreadRemoteError({
              reason: "rejected",
              detail: "This thread was not found.",
            });
          const busy = yield* busyReason(threadId);
          if (busy !== null) return yield* new ThreadRemoteError({ reason: "busy", detail: busy });
          const epoch = (row?.epoch ?? 0) + 1;
          const handoff = encodeHandoff({ target, epoch });
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, handoff_json, updated_at)
            VALUES (${threadId}, ${environmentId}, 1, ${row?.epoch ?? 0}, ${handoff}, ${now})
            ON CONFLICT(thread_id) DO UPDATE SET handoff_json = excluded.handoff_json, updated_at = excluded.updated_at`;
          return { epoch };
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.die(new ThreadReplicationError({ reason: "storage", cause })),
        }),
      );

  const release: ThreadReplication["Service"]["release"] = (threadId) =>
    sql`UPDATE thread_owners SET handoff_json = NULL WHERE thread_id = ${threadId} AND local = 1`.pipe(
      Effect.asVoid,
      Effect.orDie,
    );

  const finish: ThreadReplication["Service"]["finish"] = (threadId) =>
    Effect.gen(function* () {
      const row = (yield* ownerRows([threadId])).get(threadId);
      if (row?.handoff_json == null || row.local === 0) return;
      const { target, epoch } = decodeHandoff(row.handoff_json);
      const now = DateTime.formatIso(yield* DateTime.now);
      // The previous owner keeps a replica; where it ran travels for a later move back.
      const source = yield* localSource(threadId);
      yield* sql`UPDATE thread_owners SET owner_env = ${target}, local = 0, epoch = ${epoch},
          handoff_json = NULL, source_json = ${source === null ? null : encodeSource(source)}, updated_at = ${now}
        WHERE thread_id = ${threadId}`;
    }).pipe(Effect.orDie);

  const fenced: ThreadReplication["Service"]["fenced"] = sql<{
    readonly thread_id: string;
    readonly handoff_json: string;
  }>`SELECT thread_id, handoff_json FROM thread_owners WHERE local = 1 AND handoff_json IS NOT NULL`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        threadId: ThreadId.make(row.thread_id),
        ...decodeHandoff(row.handoff_json),
      })),
    ),
    Effect.orDie,
  );

  const take: ThreadReplication["Service"]["take"] = (threadId, from, epoch) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* ownerRows([threadId])).get(threadId);
          // Only the owner at epoch - 1 can start this handoff, so a newer
          // epoch here means it was taken (and maybe moved on since).
          if (row !== undefined && row.epoch >= epoch) return "already" as const;
          if (
            row === undefined ||
            row.local === 1 ||
            row.owner_env !== from ||
            row.epoch + 1 !== epoch
          )
            return yield* new ThreadRemoteError({
              reason: "not-owner",
              detail: "This machine does not have that thread from the machine moving it.",
            });
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`UPDATE thread_owners SET owner_env = ${environmentId}, local = 1, epoch = ${epoch},
              handoff_json = NULL, updated_at = ${now}
            WHERE thread_id = ${threadId}`;
          return "taken" as const;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.die(new ThreadReplicationError({ reason: "storage", cause })),
        }),
      );

  const sourceProject: ThreadReplication["Service"]["sourceProject"] = (threadId) =>
    Effect.gen(function* () {
      const row = (yield* ownerRows([threadId])).get(threadId);
      const source =
        row?.source_json == null
          ? null
          : yield* decodeSource(row.source_json).pipe(Effect.orElseSucceed(() => null));
      return { source, projectId: yield* localProject(source) };
    }).pipe(Effect.orDie);

  yield* replayHeld;
  return ThreadReplication.of({
    environmentId,
    owner,
    remoteOwners,
    readBatch,
    receive,
    cursors,
    acknowledge,
    changes,
    fence,
    release,
    finish,
    fenced,
    take,
    sourceProject,
  });
});

export const layer = Layer.effect(ThreadReplication, make);
