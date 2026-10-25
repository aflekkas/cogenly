import { projectReplicaFilings } from "./replicaFiling.ts";
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
  type EventId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  ProjectId,
  ProjectLabelId,
  THREAD_REPLICATION_BATCH_BYTES,
  THREAD_REPLICATION_BATCH_EVENTS,
  ThreadId,
  ThreadReplicaSource,
  ThreadReplicaMeta,
  ThreadReplicaCommandReceipt,
  type ThreadReplicationBatch,
  type ThreadReplicationCursor,
  ThreadReplicationError,
  ThreadRemoteError,
} from "@cogenly/contracts";
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
    /**
     * trustedRelay is true only for this spoke's pinned hub. Ownership claims
     * from other peers require a handoff this machine witnessed.
     */
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
    /** The checks fence makes, without fencing: for a dry run. */
    readonly preflight: (
      threadId: ThreadId,
      recovery?: boolean,
    ) => Effect.Effect<void, ThreadRemoteError>;
    /** Drop a fence the target refused; the thread runs here again. */
    readonly release: (
      threadId: ThreadId,
      target: EnvironmentId,
      epoch: number,
    ) => Effect.Effect<void>;
    /** The target took the thread: record it as the owner and drop the fence. */
    readonly finish: (
      threadId: ThreadId,
      target: EnvironmentId,
      epoch: number,
    ) => Effect.Effect<void>;
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
    /**
     * On the hub, before relaying a spoke's handoff: the target's claim on
     * the thread at `epoch` is expected. Without this the hub accepts an
     * owner change only through the handoff it witnessed.
     */
    readonly expectHandoff: (
      threadId: ThreadId,
      from: EnvironmentId,
      target: EnvironmentId,
      epoch: number,
    ) => Effect.Effect<void, ThreadRemoteError>;
    /** A relayed target definitely refused before taking ownership. */
    readonly cancelExpectedHandoff: (
      threadId: ThreadId,
      from: EnvironmentId,
      target: EnvironmentId,
      epoch: number,
    ) => Effect.Effect<void>;
    /**
     * Run here a thread whose owner, or the machine it was being handed to,
     * is gone: an explicit recovery the caller has checked (`lost` is not
     * paired). Returns the new epoch; undefined when `lost` has no claim on it.
     */
    readonly adopt: (
      threadId: ThreadId,
      lost: EnvironmentId,
    ) => Effect.Effect<{ readonly epoch: number; readonly replica: boolean } | undefined>;
    /** Threads `lost` runs as far as this machine knows, or that are being handed to it. */
    readonly claimedBy: (lost: EnvironmentId) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Owners recorded here that are not in `paired`, with how many threads each has. */
    readonly unpairedOwners: (
      paired: ReadonlySet<EnvironmentId>,
    ) => Effect.Effect<ReadonlyArray<{ readonly owner: EnvironmentId; readonly threads: number }>>;
    /** Events of the thread that replicate, for the target to confirm it has them all. */
    readonly eventCount: (threadId: ThreadId) => Effect.Effect<number>;
    /** This machine's checkout of the project a replica runs in on its owner. */
    readonly sourceProject: (threadId: ThreadId) => Effect.Effect<{
      readonly source: ThreadReplicaSource | null;
      readonly projectId: ProjectId | undefined;
    }>;
    /** Where a thread in `projectId` runs, in terms another machine can map. */
    readonly projectSource: (projectId: ProjectId) => Effect.Effect<ThreadReplicaSource>;
    /** This machine's checkout of a portable source; undefined when it has none. */
    readonly localProject: (
      source: Pick<ThreadReplicaSource, "kind" | "remote">,
    ) => Effect.Effect<ProjectId | undefined>;
  }
>()("cogenly-server/threadSync/ThreadReplication") {}

const isReplicationError = Schema.is(ThreadReplicationError);
const isPortableSource = Schema.is(ThreadReplicaSource);
const storage = (cause: unknown) =>
  isReplicationError(cause) ? cause : new ThreadReplicationError({ reason: "storage", cause });
const encodeEventJson = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const decodeEventJson = Schema.decodeUnknownOption(OrchestrationV2DomainEventJson);
const encodeMeta = Schema.encodeEffect(ThreadReplicaMeta);
const decodeReceipt = Schema.decodeUnknownOption(ThreadReplicaCommandReceipt);
const decodeReceiptTime = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString);
const decodeMeta = Schema.decodeUnknownOption(ThreadReplicaMeta);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/**
 * T3 Code's no-project folder, or a per-chat folder in it: imports from T3
 * Code once recorded these as repositories (migration 084 keeps those that
 * still own threads). Their threads are scratch chats on any machine.
 */
const isT3Scratch = (root: string) => /(^|[\\/])\.t3[\\/]scratch([\\/]|$)/.test(root);
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
  readonly meta_extra_json: string | null;
}

/** Metadata keys this build does not know, from a newer owner; relayed as received. */
const metaExtras = (raw: unknown) => encodeJson(raw);

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

  /** Events as another machine sent them, kept where this build would drop fields. */
  const rawEvents = (eventIds: ReadonlyArray<string>) =>
    eventIds.length === 0
      ? Effect.succeed(new Map<string, Schema.Json>())
      : sql<{
          readonly event_id: string;
          readonly event_json: string;
        }>`SELECT event_id, event_json FROM thread_replication_raw_events WHERE event_id IN ${sql.in(eventIds)}`.pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.flatMap((row) =>
                  Option.toArray(decodeJsonOption(row.event_json)).map(
                    (json) => [row.event_id, json as Schema.Json] as const,
                  ),
                ),
              ),
          ),
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
    }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    return rows[0] === undefined
      ? null
      : yield* projectSourceOf(ProjectId.make(rows[0].project_id));
  });

  const projectSourceOf = Effect.fn("ThreadReplication.projectSource")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{
      readonly workspace_root: string | null;
      readonly remote: string | null;
    }>`SELECT (SELECT p.workspace_root FROM projection_projects p WHERE p.project_id = ${projectId}) AS workspace_root,
        COALESCE(
          (SELECT r.remote FROM label_repositories r WHERE r.repository_id = ${projectId} AND r.remote IS NOT NULL LIMIT 1),
          (SELECT c.remote FROM shared_repository_checkouts c WHERE c.repository_id = ${projectId} LIMIT 1)
        ) AS remote`;
    const row = rows[0] ?? { workspace_root: null, remote: null };
    if (
      row.workspace_root !== null &&
      (path.resolve(row.workspace_root) === scratchRoot || isT3Scratch(row.workspace_root))
    )
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
    const retained =
      row?.local === 0 && row.meta_extra_json !== null
        ? Option.flatMap(decodeJsonOption(row.meta_extra_json), decodeMeta)
        : Option.none();
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
      folderId: Option.isSome(retained)
        ? retained.value.folderId
        : folder[0]?.folder_id
          ? ProjectLabelId.make(folder[0].folder_id)
          : null,
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
    const listed = yield* sql<{
      readonly sequence: number;
      readonly stream_id: string;
      readonly bytes: number;
    }>`
      SELECT e.sequence, e.stream_id, max(length(CAST(e.payload_json AS BLOB)) + 2048, COALESCE(length(CAST(r.event_json AS BLOB)), 0)) AS bytes
      FROM orchestration_events e LEFT JOIN thread_replication_raw_events r ON r.event_id = e.event_id
      WHERE e.sequence > ${after.events} AND e.sequence <= ${latest.events}
        AND e.aggregate_kind = 'thread' AND e.application_event_version = 2
        AND ${ownerFilter}
      ORDER BY e.sequence LIMIT ${THREAD_REPLICATION_BATCH_EVENTS}`;
    // Fewer candidates than the limit: everything up to `latest` was examined.
    let eventsCursor =
      listed.length < THREAD_REPLICATION_BATCH_EVENTS ? latest.events : listed.at(-1)!.sequence;
    // Size the batch from stored sizes before reading, so a run of large
    // events is never loaded only to be cut; the first always travels.
    const budget = THREAD_REPLICATION_BATCH_BYTES - 64 * 1024;
    let planned = 0;
    let take = 0;
    while (take < listed.length && (take === 0 || planned + listed[take]!.bytes <= budget)) {
      planned += listed[take]!.bytes;
      take++;
    }
    if (take < listed.length) eventsCursor = listed[take]!.sequence - 1;
    const candidates = listed.slice(0, take);
    const events: Array<Schema.Json> = [];
    const eventThreads: Array<ThreadId> = [];
    const eventSequences: Array<number> = [];
    if (candidates.length > 0) {
      // Read each thread's own run: the range between candidates can hold
      // many events this batch skips (threads the target owns).
      const runs = new Map<string, { first: number; last: number }>();
      for (const row of candidates) {
        const run = runs.get(row.stream_id);
        runs.set(row.stream_id, { first: run?.first ?? row.sequence, last: row.sequence });
      }
      const wanted = new Set(candidates.map((row) => row.sequence));
      const stored = (yield* Effect.forEach(runs, ([streamId, run]) =>
        Stream.runCollect(
          eventStore.read({
            threadId: ThreadId.make(streamId),
            afterSequence: run.first - 1,
            throughSequence: run.last,
          }),
        ),
      ))
        .flat()
        .filter((item) => wanted.has(item.sequence))
        .sort((left, right) => left.sequence - right.sequence);
      const raw = yield* rawEvents(stored.map((item) => item.event.id));
      const commandIds = [
        ...new Set(stored.flatMap((item) => (item.commandId === null ? [] : [item.commandId]))),
      ];
      const receipts =
        commandIds.length === 0
          ? []
          : yield* sql<{
              readonly command_id: string;
              readonly aggregate_id: string;
              readonly command_type: string;
              readonly accepted_at: string;
              readonly status: "accepted" | "rejected";
              readonly error: string | null;
            }>`SELECT command_id, aggregate_id, command_type, accepted_at, status, error FROM orchestration_command_receipts
        WHERE command_id IN ${sql.in(commandIds)} AND aggregate_kind = 'thread'`;
      const byCommand = new Map(receipts.map((row) => [row.command_id, row]));
      for (const item of stored) {
        // A newer build's fields this one cannot read travel on as received.
        const kept = raw.get(item.event.id);
        const encoded =
          kept === undefined ? ((yield* encodeEventJson(item.event)) as Schema.Json) : kept;
        const receipt = item.commandId == null ? undefined : byCommand.get(item.commandId);
        events.push(
          receipt !== undefined && receipt.aggregate_id === item.event.threadId
            ? ({
                ...(encoded as object),
                cogenlyReplicaReceipt: {
                  commandId: receipt.command_id,
                  commandType: receipt.command_type,
                  acceptedAt: receipt.accepted_at,
                  status: receipt.status,
                  error: receipt.error,
                },
              } as Schema.Json)
            : encoded,
        );
        eventThreads.push(item.event.threadId);
        eventSequences.push(item.sequence);
      }
    }
    const metaRows = yield* sql<{
      readonly seq: number;
      readonly thread_id: string;
    }>`SELECT seq, thread_id FROM thread_replication_meta_log WHERE seq > ${after.meta} AND seq <= ${latest.meta} ORDER BY seq LIMIT ${THREAD_REPLICATION_BATCH_EVENTS}`;
    let metaCursor =
      metaRows.length < THREAD_REPLICATION_BATCH_EVENTS ? latest.meta : metaRows.at(-1)!.seq;
    const threadIds = [...new Set([...eventThreads, ...metaRows.map((row) => row.thread_id)])];
    const owners = yield* ownerRows(threadIds);
    const include = sendable(target, localOnly);
    const meta = yield* Effect.forEach(
      threadIds.filter((threadId) => include(owners.get(threadId))),
      (threadId) =>
        metaFor(threadId, owners.get(threadId)).pipe(
          Effect.flatMap(encodeMeta),
          Effect.map((encoded) => {
            // A relayed thread keeps the keys its newer owner sent.
            const extras = owners.get(threadId)?.meta_extra_json;
            const kept =
              extras == null ? undefined : Option.getOrUndefined(decodeJsonOption(extras));
            return (
              typeof kept === "object" && kept !== null
                ? {
                    ...kept,
                    ...encoded,
                    source:
                      encoded.source === null
                        ? null
                        : {
                            ...(rawField(kept, "source") as object | null),
                            ...encoded.source,
                          },
                  }
                : encoded
            ) as Schema.Json;
          }),
        ),
    );
    // Enforce the wire budget, including envelopes, raw fields and metadata.
    // A single oversized item travels alone rather than wedging the cursor.
    const byThread = new Map(meta.map((item) => [rawThreadId(item)!, item]));
    const selectedMeta = new Map<string, Schema.Json>();
    const selectedEvents: Array<Schema.Json> = [];
    const bytes = (value: unknown) => Buffer.byteLength(encodeJson(value));
    let used = bytes({
      after,
      cursor: { events: eventsCursor, meta: metaCursor },
      events: [],
      meta: [],
    });
    for (let at = 0; at < events.length; at++) {
      const id = eventThreads[at]!;
      const metadata = selectedMeta.has(id) ? undefined : byThread.get(id);
      const size = bytes(events[at]) + (metadata === undefined ? 0 : bytes(metadata)) + 2;
      if (selectedEvents.length > 0 && used + size > THREAD_REPLICATION_BATCH_BYTES) {
        eventsCursor = eventSequences[at]! - 1;
        break;
      }
      selectedEvents.push(events[at]!);
      if (metadata !== undefined) selectedMeta.set(id, metadata);
      used += size;
    }
    for (const row of metaRows) {
      const metadata = byThread.get(row.thread_id);
      if (metadata === undefined || selectedMeta.has(row.thread_id)) continue;
      const size = bytes(metadata) + 1;
      if (
        (selectedEvents.length > 0 || selectedMeta.size > 0) &&
        used + size > THREAD_REPLICATION_BATCH_BYTES
      ) {
        metaCursor = row.seq - 1;
        break;
      }
      selectedMeta.set(row.thread_id, metadata);
      used += size;
    }
    return {
      after,
      cursor: { events: eventsCursor, meta: metaCursor },
      events: selectedEvents,
      meta: [...selectedMeta.values()],
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
    source: Pick<ThreadReplicaSource, "kind" | "remote"> | null,
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
    metas: ReadonlyArray<{ readonly meta: ThreadReplicaMeta; readonly raw: unknown }>,
    items: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent; readonly raw: unknown }>,
    source: EnvironmentId,
    commandKey: string,
    trustedRelay: boolean,
  ) {
    const metaByThread = new Map(metas.map((item) => [item.meta.threadId, item]));
    const owners = yield* ownerRows([...metaByThread.keys()]);
    const present = new Set(
      (metaByThread.size === 0
        ? []
        : yield* sql<{
            readonly thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in([...metaByThread.keys()])}`
      ).map((row) => row.thread_id),
    );
    const accepted = new Map<
      ThreadId,
      {
        meta: ThreadReplicaMeta;
        raw: unknown;
        handedOff: boolean;
        previous: OwnerRow | undefined;
        projectId?: ProjectId;
      }
    >();
    for (const { meta, raw } of metaByThread.values()) {
      const row = owners.get(meta.threadId);
      // Handing a thread to this machine is the handoff protocol's decision, never a replica's.
      if (meta.owner === environmentId) continue;
      const pending = row?.handoff_json == null ? undefined : decodeHandoff(row.handoff_json);
      // This machine is handing the thread to meta.owner, and meta.owner
      // already runs it at the handoff's epoch: only a take writes that, so
      // the handoff finished and its answer is late or lost. Skipping here
      // would drop the new owner's first events for good.
      const handedOff =
        row?.local === 1 &&
        pending !== undefined &&
        (pending.target === meta.owner || trustedRelay) &&
        meta.epoch >= pending.epoch;
      if (!handedOff && (row === undefined ? present.has(meta.threadId) : row.local === 1)) {
        yield* Effect.logWarning("Skipping a replicated thread this machine also runs", {
          threadId: meta.threadId,
          owner: meta.owner,
        });
        continue;
      }
      if (row !== undefined && !handedOff) {
        if (meta.epoch < row.epoch) continue;
        if (meta.epoch === row.epoch && meta.owner !== row.owner_env) {
          yield* Effect.logWarning("Skipping a conflicting thread owner", {
            threadId: meta.threadId,
          });
          continue;
        }
        // A machine speaking for itself may claim a thread another machine
        // runs only through a handoff this hub relayed. Unpairing does not
        // authorize a peer to seize the thread; recovery is a local owner action.
        if (
          meta.owner !== row.owner_env &&
          !trustedRelay &&
          !(pending !== undefined && pending.target === meta.owner && pending.epoch === meta.epoch)
        ) {
          yield* Effect.logWarning("Skipping an ownership claim without a handoff", {
            threadId: meta.threadId,
            owner: row.owner_env,
            claimedBy: meta.owner,
          });
          continue;
        }
      }
      const projectId = yield* localProject(meta.source);
      accepted.set(meta.threadId, {
        meta,
        raw,
        handedOff,
        previous: row,
        ...(projectId === undefined ? {} : { projectId }),
      });
    }

    // Owners first: a crash after this leaves an empty replica, never a thread
    // whose events look like this machine's own.
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.forEach(
        accepted.values(),
        ({ meta, raw, handedOff, previous }) => {
          const sourceJson = meta.source === null ? null : encodeSource(meta.source);
          return handedOff
            ? sql`UPDATE thread_owners SET owner_env = ${meta.owner}, local = 0, epoch = ${meta.epoch},
                  handoff_json = NULL, source_json = ${sourceJson}, meta_extra_json = ${metaExtras(raw)},
                  updated_at = ${now}
                WHERE thread_id = ${meta.threadId} AND local = 1 AND epoch = ${previous!.epoch}
                  AND handoff_json = ${previous!.handoff_json}`
            : sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, source_json, meta_extra_json, updated_at)
                VALUES (${meta.threadId}, ${meta.owner}, 0, ${meta.epoch}, ${sourceJson}, ${metaExtras(raw)}, ${now})
                ON CONFLICT(thread_id) DO UPDATE SET owner_env = excluded.owner_env, epoch = excluded.epoch,
                  handoff_json = CASE WHEN thread_owners.owner_env = excluded.owner_env AND thread_owners.epoch = excluded.epoch
                    THEN thread_owners.handoff_json ELSE NULL END, source_json = excluded.source_json,
                  meta_extra_json = excluded.meta_extra_json, updated_at = excluded.updated_at
                WHERE thread_owners.local = 0 AND thread_owners.epoch <= excluded.epoch`;
        },
        { discard: true },
      ),
    );

    // Each event speaks for its own thread: the projection keys thread rows
    // by the payload's id, so a mismatched one would rewrite another thread.
    const consistent = (event: OrchestrationV2DomainEvent) => {
      const payload = event.payload as Record<string, unknown> | null;
      if (typeof payload !== "object" || payload === null) return true;
      if (typeof payload.threadId === "string" && payload.threadId !== event.threadId) return false;
      if (typeof payload.appThreadId === "string" && payload.appThreadId !== event.threadId)
        return false;
      return !(
        event.type.startsWith("thread.") &&
        "projectId" in payload &&
        payload.id !== event.threadId
      );
    };
    const rawById = new Map(items.map((item) => [item.event.id, item.raw]));
    const candidates: Array<OrchestrationV2DomainEvent> = [];
    for (const { event } of items) {
      if (!accepted.has(event.threadId)) continue;
      if (consistent(event)) candidates.push(event);
      else return yield* new ThreadReplicationError({ reason: "invalid-batch" });
    }
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
      // This build drops payload keys it does not know. Keep the event as
      // sent when it had any, so relaying it, or running the thread here and
      // moving it on, passes them along (readBatch sends the kept copy).
      const retainedEvents: Array<{ id: EventId; json: string }> = [];
      for (const event of candidates) {
        const raw = rawById.get(event.id);
        if (stored.has(event.id) || raw === undefined) continue;
        const sent = encodeJson(raw);
        if (sent === encodeJson(yield* encodeEventJson(event))) continue;
        retainedEvents.push({ id: event.id, json: sent });
      }
      const receipts = [];
      for (const event of candidates) {
        if (stored.has(event.id)) continue;
        const raw = rawField(rawById.get(event.id), "cogenlyReplicaReceipt");
        if (raw === undefined) continue;
        const receipt = decodeReceipt(raw);
        if (Option.isNone(receipt))
          return yield* new ThreadReplicationError({ reason: "invalid-batch" });
        receipts.push({
          ...receipt.value,
          threadId: event.threadId,
          acceptedAt: yield* decodeReceiptTime(receipt.value.acceptedAt),
        });
      }
      // Refuse the batch on a storage/projection failure; retry it without advancing the cursor.
      yield* eventSink.writeReplica({
        commandId,
        events: fresh,
        retainedEvents,
        receipts,
        owners: [...accepted.values()].map(({ meta }) => ({
          threadId: meta.threadId,
          owner: meta.owner,
          epoch: meta.epoch,
        })),
      });
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const { meta } of accepted.values()) {
          const current = yield* sql`SELECT 1 FROM thread_owners WHERE thread_id = ${meta.threadId}
            AND local = 0 AND owner_env = ${meta.owner} AND epoch = ${meta.epoch}`;
          if (current.length === 0) continue;
          yield* projectReplicaFilings(meta.threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
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
      metas: metas
        .filter((item) => !isHeld(item))
        .flatMap((item) => Option.toArray(item.decoded).map((meta) => ({ meta, raw: item.raw }))),
      events: events
        .filter((item) => !isHeld(item))
        .flatMap((item) => Option.toArray(item.decoded).map((event) => ({ event, raw: item.raw }))),
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
            SELECT ${item.threadId!}, ${item.kind}, ${source}, ${trustedRelay ? 1 : 0}, ${encodeJson(item.raw)}
            WHERE NOT EXISTS (SELECT 1 FROM thread_replication_deferred
              WHERE thread_id = ${item.threadId!} AND source_env = ${source}
                AND item_kind = ${item.kind} AND item_json = ${encodeJson(item.raw)})`;
      }
      yield* applyItems(split.metas, split.events, source, `${batch.cursor.events}`, trustedRelay);
      // Never moves back: a batch that only advances one cursor must not rewind the other.
      yield* sql`INSERT INTO thread_replication_cursors(environment_id, received_events, received_meta)
        VALUES (${source}, ${batch.cursor.events}, ${batch.cursor.meta})
        ON CONFLICT(environment_id) DO UPDATE SET
          received_events = max(received_events, excluded.received_events),
          received_meta = max(received_meta, excluded.received_meta)`;
      return { acknowledged: batch.cursor };
    },
    Effect.mapError(storage),
  );

  // Read sizes before payloads: a page holds at most 128 items and the normal
  // byte budget, allowing a metadata/event pair even when one item is oversized.
  const heldPage = (threadId: string, after: number, through: number) =>
    Effect.gen(function* () {
      const sizes = yield* sql<{ readonly seq: number; readonly bytes: number }>`
      SELECT seq, length(CAST(item_json AS BLOB)) AS bytes FROM thread_replication_deferred
      WHERE thread_id = ${threadId} AND seq > ${after} AND seq <= ${through}
      ORDER BY seq LIMIT 128`;
      let end = after;
      let bytes = 0;
      let count = 0;
      for (const row of sizes) {
        if (count >= 2 && bytes + row.bytes > THREAD_REPLICATION_BATCH_BYTES) break;
        bytes += row.bytes;
        count++;
        end = row.seq;
      }
      return yield* sql<{
        readonly seq: number;
        readonly item_kind: "meta" | "event";
        readonly source_env: string;
        readonly trusted_relay: number;
        readonly item_json: string;
      }>`SELECT seq, item_kind, source_env, trusted_relay, item_json FROM thread_replication_deferred
      WHERE thread_id = ${threadId} AND seq > ${after} AND seq <= ${end} ORDER BY seq`;
    });
  const decodeHeld = (row: Effect.Success<ReturnType<typeof heldPage>>[number]) => {
    const raw = decodeJsonOption(row.item_json);
    return {
      row,
      raw: Option.getOrUndefined(raw),
      meta: row.item_kind === "meta" ? Option.flatMap(raw, decodeMeta) : Option.none(),
      event: row.item_kind === "event" ? Option.flatMap(raw, decodeEventJson) : Option.none(),
    };
  };

  /** Readability is checked incrementally before any part of a thread applies. */
  const readableHeld = (threadId: string, through: number) =>
    Effect.gen(function* () {
      let after = 0;
      for (;;) {
        const page = yield* heldPage(threadId, after, through);
        if (page.length === 0) return true;
        for (const row of page) {
          const item = decodeHeld(row);
          if (Option.isNone(item.meta) && Option.isNone(item.event)) return false;
        }
        after = page.at(-1)!.seq;
      }
    });

  /** Replay bounded chunks; deletion and application commit together as durable progress. */
  const replayHeld = Effect.gen(function* () {
    let afterThread = "";
    for (;;) {
      const next = (yield* sql<{ readonly thread_id: string; readonly through: number }>`
        SELECT thread_id, MAX(seq) AS through FROM thread_replication_deferred
        WHERE thread_id > ${afterThread} GROUP BY thread_id ORDER BY thread_id LIMIT 1`)[0];
      if (next === undefined) return;
      const { thread_id: threadId, through } = next;
      afterThread = threadId;
      if (!(yield* readableHeld(threadId, through))) continue;
      for (;;) {
        const page = (yield* heldPage(threadId, 0, through)).map(decodeHeld);
        if (page.length === 0) break;
        const end = page.at(-1)!.row.seq;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Keep sender runs separate. Each batch starts with metadata; retain
            // the final run's last meta row as context for the next chunk/restart.
            let at = 0;
            let retained: number | null = null;
            while (at < page.length) {
              const first = page[at]!.row;
              let stop = at + 1;
              while (
                stop < page.length &&
                page[stop]!.row.source_env === first.source_env &&
                page[stop]!.row.trusted_relay === first.trusted_relay
              )
                stop++;
              const run = page.slice(at, stop);
              const metas = run.flatMap((item) =>
                Option.toArray(item.meta).map((meta) => ({ meta, raw: item.raw })),
              );
              const events = run.flatMap((item) =>
                Option.toArray(item.event).map((event) => ({ event, raw: item.raw })),
              );
              if (metas.length === 0 && events.length > 0)
                return yield* new ThreadReplicationError({ reason: "invalid-batch" });
              yield* applyItems(
                metas,
                events,
                EnvironmentId.make(first.source_env),
                `held:${run.at(-1)!.row.seq}`,
                first.trusted_relay === 1,
              );
              retained = run.findLast((item) => Option.isSome(item.meta))?.row.seq ?? null;
              at = stop;
            }
            yield* sql`DELETE FROM thread_replication_deferred WHERE thread_id = ${threadId} AND seq <= ${end}
            ${end === through || retained === null ? sql`` : sql`AND seq <> ${retained}`}`;
          }),
        );
        if (end === through) break;
      }
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
        WHEN EXISTS (SELECT 1 FROM agent_work_runs w JOIN agents a ON a.agent_id = w.agent_id
          WHERE a.conversation_thread_id = ${threadId}
          AND (w.status IN ('starting','running') OR w.posted = 0)) THEN 'An agent job is active or awaiting completion delivery.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
          AND status IN ('queued','preparing','starting','running','waiting')) THEN 'It has a turn running or queued.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId}
          AND status IN ('pending','waiting')) THEN 'It is waiting for an answer.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}
          AND status IN ('pending','starting','running','waiting')) THEN 'A subagent is still working.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}
          AND json_array_length(json_extract(payload_json, '$.pendingBackgroundTasks')) > 0) THEN 'Provider background work is still running.'
        WHEN EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
          AND status IN ('pending','running')) THEN 'It is still finishing its last turn.'
        ELSE NULL END AS busy`.pipe(Effect.map((rows) => rows[0]?.busy ?? null));

  // Why this machine cannot hand the thread off now; the row when it can.
  const movable = (threadId: ThreadId, recovery = false) =>
    Effect.gen(function* () {
      const row = (yield* ownerRows([threadId])).get(threadId);
      if (!recovery && row !== undefined && row.local === 0)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      if (!recovery && row?.handoff_json != null)
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
      return row;
    });

  const preflight: ThreadReplication["Service"]["preflight"] = (threadId, recovery) =>
    movable(threadId, recovery).pipe(
      Effect.asVoid,
      Effect.catchTags({
        SqlError: (cause) => Effect.die(new ThreadReplicationError({ reason: "storage", cause })),
      }),
    );

  const fence: ThreadReplication["Service"]["fence"] = (threadId, target) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* movable(threadId);
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

  const release: ThreadReplication["Service"]["release"] = (threadId, target, epoch) =>
    sql`UPDATE thread_owners SET handoff_json = NULL WHERE thread_id = ${threadId} AND local = 1
      AND handoff_json = ${encodeHandoff({ target, epoch })}`.pipe(Effect.asVoid, Effect.orDie);

  const finish: ThreadReplication["Service"]["finish"] = (
    threadId,
    expectedTarget,
    expectedEpoch,
  ) =>
    Effect.gen(function* () {
      const row = (yield* ownerRows([threadId])).get(threadId);
      if (row?.handoff_json == null || row.local === 0) return;
      const { target, epoch } = decodeHandoff(row.handoff_json);
      if (target !== expectedTarget || epoch !== expectedEpoch) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      // The previous owner keeps a replica; where it ran travels for a later move back.
      const source = yield* localSource(threadId);
      yield* sql`UPDATE thread_owners SET owner_env = ${target}, local = 0, epoch = ${epoch},
          handoff_json = NULL, source_json = ${source === null ? null : encodeSource(source)}, updated_at = ${now}
        WHERE thread_id = ${threadId} AND local = 1 AND epoch = ${row.epoch} AND handoff_json = ${row.handoff_json}`;
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

  const expectHandoff: ThreadReplication["Service"]["expectHandoff"] = (
    threadId,
    from,
    target,
    epoch,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* ownerRows([threadId])).get(threadId);
          if (row !== undefined && row.epoch >= epoch) return;
          const pending = row?.handoff_json == null ? undefined : decodeHandoff(row.handoff_json);
          if (
            row === undefined ||
            row.local === 1 ||
            row.owner_env !== from ||
            row.epoch + 1 !== epoch ||
            (pending !== undefined && (pending.target !== target || pending.epoch !== epoch))
          )
            return yield* new ThreadRemoteError({ reason: "not-owner" });
          yield* sql`UPDATE thread_owners SET handoff_json = ${encodeHandoff({ target, epoch })}
        WHERE thread_id = ${threadId}`;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.die(new ThreadReplicationError({ reason: "storage", cause })),
        }),
      );

  const cancelExpectedHandoff: ThreadReplication["Service"]["cancelExpectedHandoff"] = (
    threadId,
    from,
    target,
    epoch,
  ) =>
    sql`UPDATE thread_owners SET handoff_json = NULL
      WHERE thread_id = ${threadId} AND local = 0 AND owner_env = ${from} AND epoch = ${epoch - 1}
        AND handoff_json = ${encodeHandoff({ target, epoch })}`.pipe(Effect.asVoid, Effect.orDie);

  const adopt: ThreadReplication["Service"]["adopt"] = (threadId, lost) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = (yield* ownerRows([threadId])).get(threadId);
          if (row === undefined) return undefined;
          const now = DateTime.formatIso(yield* DateTime.now);
          if (row.local === 0) {
            if (row.owner_env !== lost) return undefined;
            const epoch = row.epoch + 1;
            yield* sql`UPDATE thread_owners SET owner_env = ${environmentId}, local = 1, epoch = ${epoch},
                handoff_json = NULL, updated_at = ${now}
              WHERE thread_id = ${threadId}`;
            return { epoch, replica: true };
          }
          const pending = row.handoff_json === null ? undefined : decodeHandoff(row.handoff_json);
          if (pending?.target !== lost) return undefined;
          // The lost target may have taken it at the handoff's epoch and told
          // others; run on past that epoch so this machine's claim wins.
          const epoch = pending.epoch + 1;
          yield* sql`UPDATE thread_owners SET epoch = ${epoch}, handoff_json = NULL, updated_at = ${now}
            WHERE thread_id = ${threadId}`;
          return { epoch, replica: false };
        }),
      )
      .pipe(Effect.orDie);

  const claimedBy: ThreadReplication["Service"]["claimedBy"] = (lost) =>
    sql<{ readonly thread_id: string }>`SELECT o.thread_id FROM thread_owners o
      JOIN orchestration_v2_projection_threads t ON t.thread_id = o.thread_id
      WHERE t.deleted_at IS NULL AND (
        (o.local = 0 AND o.owner_env = ${lost})
        OR (o.local = 1 AND json_extract(o.handoff_json, '$.target') = ${lost}))
      ORDER BY o.thread_id`.pipe(
      Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
      Effect.orDie,
    );

  const unpairedOwners: ThreadReplication["Service"]["unpairedOwners"] = (paired) =>
    sql<{
      readonly owner: string;
      readonly threads: number;
    }>`SELECT owner, COUNT(*) AS threads FROM (
        SELECT CASE WHEN o.local = 0 THEN o.owner_env ELSE json_extract(o.handoff_json, '$.target') END AS owner
        FROM thread_owners o JOIN orchestration_v2_projection_threads t ON t.thread_id = o.thread_id
        WHERE t.deleted_at IS NULL AND (o.local = 0 OR o.handoff_json IS NOT NULL))
      GROUP BY owner ORDER BY owner`.pipe(
      Effect.map((rows) =>
        rows
          .map((row) => ({ owner: EnvironmentId.make(row.owner), threads: row.threads }))
          .filter((row) => row.owner !== environmentId && !paired.has(row.owner)),
      ),
      Effect.orDie,
    );

  const eventCount: ThreadReplication["Service"]["eventCount"] = (threadId) =>
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM orchestration_events
      WHERE stream_id = ${threadId} AND aggregate_kind = 'thread' AND application_event_version = 2`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.orDie,
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
  yield* sql.withTransaction(projectReplicaFilings()).pipe(Effect.orDie);
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
    preflight,
    release,
    finish,
    fenced,
    take,
    expectHandoff,
    cancelExpectedHandoff,
    adopt,
    claimedBy,
    unpairedOwners,
    eventCount,
    sourceProject,
    projectSource: (projectId) => projectSourceOf(projectId).pipe(Effect.orDie),
    localProject: (source) => localProject(source).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(ThreadReplication, make);
