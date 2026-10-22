// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to a T3 Code state database (`statev2.sqlite`).
 *
 * T3 Code and Cogenly share their schema up to migration 62, so the tables read
 * here have the same columns in both.
 *
 * T3 Code may be running while Cogenly reads it. Detection reads the live file
 * (see `openLive`). A scan or import reads a snapshot instead:
 * `snapshotT3SourceDatabase` copies the live database with SQLite's online
 * backup API into a private temp directory, in small steps inside one held
 * read transaction, so the copy is consistent and the server stays
 * responsive. The snapshot is then opened with `immutable=1`. Nothing in
 * T3's userdata is ever opened for writing.
 *
 * @module T3SourceDatabase
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export interface T3SourceProjectRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface T3SourceThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly providerInstanceId: string | null;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: string | null;
  readonly forkedFromType: string | null;
}

export interface T3SourceThreadStats {
  readonly threadId: string;
  readonly events: number;
  readonly lastSequence: number;
  readonly messages: number;
}

/** One stored V2 thread event, exactly as T3 persisted it. */
export interface T3SourceEventRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly threadId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
  readonly metadataJson: string;
}

export interface T3SourceDatabase {
  readonly path: string;
  readonly listProjects: () => ReadonlyArray<T3SourceProjectRow>;
  /** Live thread and root-thread counts per project id. */
  readonly projectThreadCounts: () => ReadonlyMap<
    string,
    { readonly threads: number; readonly roots: number }
  >;
  /** Live (not deleted) threads of the given projects. */
  readonly listThreads: (projectIds: ReadonlyArray<string>) => ReadonlyArray<T3SourceThreadRow>;
  readonly threadStats: (threadIds: ReadonlyArray<string>) => ReadonlyArray<T3SourceThreadStats>;
  /** One thread's events after `afterSequence`, oldest first. */
  readonly readThreadEvents: (input: {
    readonly threadId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }) => ReadonlyArray<T3SourceEventRow>;
  readonly close: () => void;
}

const SQL_VARIABLE_CHUNK = 500;

function chunks<A>(
  values: ReadonlyArray<A>,
  size = SQL_VARIABLE_CHUNK,
): ReadonlyArray<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : text(value);
const integer = (value: unknown): number =>
  typeof value === "number"
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : Number(value ?? 0);

const REQUIRED_TABLES = [
  "orchestration_events",
  "projection_projects",
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_messages",
];

function openReadOnly(dbPath: string, immutable: boolean) {
  if (!NodeFS.existsSync(dbPath)) {
    throw new Error(`No T3 Code database at ${dbPath}.`);
  }
  const url = NodeURL.pathToFileURL(dbPath);
  url.searchParams.set("mode", "ro");
  if (immutable) url.searchParams.set("immutable", "1");
  return new NodeSqlite.DatabaseSync(url.href, { readOnly: true });
}

/**
 * Read T3's live database. While T3 runs, its `-wal` file exists and this is
 * an ordinary read-only WAL reader, so T3's committed changes are visible.
 * A closed T3 has folded its WAL away; a WAL reader would recreate the
 * `-wal`/`-shm` files in T3's directory, so the file is read as immutable.
 */
function openLive(dbPath: string) {
  return openReadOnly(dbPath, !NodeFS.existsSync(`${dbPath}-wal`));
}

/**
 * Open a T3 V2 database strictly read-only: `live` for T3's own file, which
 * may be changing, else a snapshot nothing writes. Throws when the file is
 * missing or not a T3 V2 database.
 */
export function openT3SourceDatabase(
  dbPath: string,
  options: { readonly live: boolean } = { live: false },
): T3SourceDatabase {
  const database = options.live ? openLive(dbPath) : openReadOnly(dbPath, true);
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => text(row.name)),
    );
    for (const required of REQUIRED_TABLES) {
      if (!tables.has(required)) {
        throw new Error(`${dbPath} is not a T3 Code database (missing ${required}).`);
      }
    }
  } catch (cause) {
    database.close();
    throw cause;
  }

  // Subagent prompts may be stored once and referenced by later rows; restore
  // them the same way Cogenly's own event store does.
  const readEvents = database.prepare(`
    SELECT
      sequence,
      event_id,
      stream_id,
      event_type,
      occurred_at,
      CASE
        WHEN event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(payload_json, '$.promptSequence') = 'integer'
        THEN json_set(
          json_remove(payload_json, '$.promptSequence'),
          '$.prompt',
          (SELECT json_extract(anchor.payload_json, '$.prompt')
           FROM orchestration_events AS anchor
           WHERE anchor.sequence = json_extract(orchestration_events.payload_json, '$.promptSequence'))
        )
        ELSE payload_json
      END AS payload_json,
      metadata_json
    FROM orchestration_events
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND stream_id = ?
      AND sequence > ?
    ORDER BY sequence ASC
    LIMIT ?
  `);

  return {
    path: dbPath,
    listProjects: () =>
      database
        .prepare(
          `SELECT project_id, title, workspace_root
           FROM projection_projects
           WHERE deleted_at IS NULL
           ORDER BY created_at ASC`,
        )
        .all()
        .map((row) => ({
          projectId: text(row.project_id),
          title: text(row.title),
          workspaceRoot: text(row.workspace_root),
        })),
    projectThreadCounts: () =>
      new Map(
        database
          .prepare(
            `SELECT
               project_id,
               COUNT(*) AS threads,
               SUM(json_extract(payload_json, '$.lineage.parentThreadId') IS NULL) AS roots
             FROM orchestration_v2_projection_threads
             WHERE deleted_at IS NULL
             GROUP BY project_id`,
          )
          .all()
          .map((row) => [
            text(row.project_id),
            { threads: integer(row.threads), roots: integer(row.roots) },
          ]),
      ),
    listThreads: (projectIds) =>
      chunks(projectIds).flatMap((ids) =>
        database
          .prepare(
            `SELECT
               thread_id,
               project_id,
               provider_instance_id,
               json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
               json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
               json_extract(payload_json, '$.forkedFrom.type') AS forked_from_type
             FROM orchestration_v2_projection_threads
             WHERE deleted_at IS NULL AND project_id IN (${placeholders(ids.length)})
             ORDER BY created_at ASC, thread_id ASC`,
          )
          .all(...ids)
          .map((row) => ({
            threadId: text(row.thread_id),
            projectId: text(row.project_id),
            providerInstanceId: nullableText(row.provider_instance_id),
            parentThreadId: nullableText(row.parent_thread_id),
            relationshipToParent: nullableText(row.relationship),
            forkedFromType: nullableText(row.forked_from_type),
          })),
      ),
    threadStats: (threadIds) => {
      const messages = new Map<string, number>();
      for (const ids of chunks(threadIds)) {
        for (const row of database
          .prepare(
            `SELECT thread_id, COUNT(*) AS messages
             FROM orchestration_v2_projection_messages
             WHERE thread_id IN (${placeholders(ids.length)})
             GROUP BY thread_id`,
          )
          .all(...ids)) {
          messages.set(text(row.thread_id), integer(row.messages));
        }
      }
      return chunks(threadIds).flatMap((ids) =>
        database
          .prepare(
            `SELECT stream_id, COUNT(*) AS events, MAX(sequence) AS last_sequence
             FROM orchestration_events
             WHERE application_event_version = 2
               AND aggregate_kind = 'thread'
               AND stream_id IN (${placeholders(ids.length)})
             GROUP BY stream_id`,
          )
          .all(...ids)
          .map((row) => ({
            threadId: text(row.stream_id),
            events: integer(row.events),
            lastSequence: integer(row.last_sequence),
            messages: messages.get(text(row.stream_id)) ?? 0,
          })),
      );
    },
    readThreadEvents: ({ threadId, afterSequence, limit }) =>
      readEvents.all(threadId, afterSequence, limit).map((row) => ({
        sequence: integer(row.sequence),
        eventId: text(row.event_id),
        threadId: text(row.stream_id),
        eventType: text(row.event_type),
        occurredAt: text(row.occurred_at),
        payloadJson: text(row.payload_json),
        metadataJson: text(row.metadata_json),
      })),
    close: () => database.close(),
  };
}

/** A consistent copy of T3's database in a private temp directory; see `snapshotT3SourceDatabase`. */
export interface T3SourceSnapshot {
  readonly directory: string;
  readonly path: string;
}

/** Room a snapshot needs on top of the database itself, for the copy's journal and slack. */
const SNAPSHOT_HEADROOM_BYTES = 256 * 1024 * 1024;
/**
 * Pages per backup step (16 MB at 4 KB pages). Each step runs on Node's
 * thread pool and the event loop runs between steps, so a 12 GB copy never
 * blocks the server; it only sets how often progress is reported.
 */
const SNAPSHOT_PAGES_PER_STEP = 4096;

const fileBytes = (path: string) => {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
};

export interface T3SnapshotSpace {
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly enough: boolean;
}

/** Free space for a snapshot of `dbPath` under `tempRoot`: the database, its WAL and headroom. */
export function checkT3SnapshotSpace(input: {
  readonly dbPath: string;
  readonly tempRoot: string;
  /** Bytes free under a directory; tests pin it. */
  readonly freeBytes?: (directory: string) => number;
}): T3SnapshotSpace {
  const requiredBytes =
    fileBytes(input.dbPath) + fileBytes(`${input.dbPath}-wal`) + SNAPSHOT_HEADROOM_BYTES;
  const availableBytes = (
    input.freeBytes ??
    ((directory) => {
      const stats = NodeFS.statfsSync(directory);
      return Number(stats.bavail) * Number(stats.bsize);
    })
  )(input.tempRoot);
  return { requiredBytes, availableBytes, enough: availableBytes >= requiredBytes };
}

export const defaultT3SnapshotRoot = () => NodeOS.tmpdir();

/** How far a snapshot copy has got, reported between backup steps. */
export interface T3SnapshotProgress {
  readonly copiedBytes: number;
  readonly totalBytes: number;
}

/**
 * Copy the live database at `dbPath` into a new directory under `tempRoot`.
 * The source is opened read-only and one read transaction is held across
 * every backup step: SQLite's backup reuses it, so the copy reflects one
 * moment even while T3 keeps writing, and T3's writes never restart it.
 * Later T3 changes are simply not in it. `onProgress` runs between steps.
 * Check space with `checkT3SnapshotSpace` first, and remove the snapshot
 * with `removeT3SourceSnapshot`.
 */
export async function snapshotT3SourceDatabase(input: {
  readonly dbPath: string;
  readonly tempRoot: string;
  readonly onProgress?: (progress: T3SnapshotProgress) => void;
  /** Pages per step; tests shrink it to exercise stepping on a small database. */
  readonly pagesPerStep?: number;
}): Promise<T3SourceSnapshot> {
  const source = openLive(input.dbPath);
  const directory = NodeFS.mkdtempSync(NodePath.join(input.tempRoot, "cogenly-t3-import-"));
  const path = NodePath.join(directory, "statev2.sqlite");
  try {
    const pageSize = integer(source.prepare("PRAGMA page_size").get()?.page_size);
    // A deferred BEGIN takes its read lock at the first read (the page count); every step then shares it.
    source.exec("BEGIN");
    const totalBytes = integer(source.prepare("PRAGMA page_count").get()?.page_count) * pageSize;
    await NodeSqlite.backup(source, path, {
      rate: input.pagesPerStep ?? SNAPSHOT_PAGES_PER_STEP,
      ...(input.onProgress === undefined
        ? {}
        : {
            progress: ({ totalPages, remainingPages }: NodeSqlite.BackupProgressInfo) =>
              input.onProgress?.({
                copiedBytes: (totalPages - remainingPages) * pageSize,
                totalBytes: totalPages * pageSize,
              }),
          }),
    });
    // Node reports between steps only, so the last step's completion is reported here.
    input.onProgress?.({ copiedBytes: totalBytes, totalBytes });
    source.exec("ROLLBACK");
    // The copy inherits WAL mode; fold it into one file so `immutable` reads are exact.
    const copy = new NodeSqlite.DatabaseSync(path);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    return { directory, path };
  } catch (cause) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
    throw cause;
  } finally {
    source.close();
  }
}

export function removeT3SourceSnapshot(snapshot: T3SourceSnapshot): void {
  NodeFS.rmSync(snapshot.directory, { recursive: true, force: true });
}

/**
 * Stream the events of many threads in T3's original global order, so a
 * parent's subagent rows and the child threads they point at are replayed in
 * the order they happened. Each thread is read through its own index range and
 * the cursors are merged, which avoids scanning T3's whole event table.
 */
export function* mergeThreadEvents(input: {
  readonly database: Pick<T3SourceDatabase, "readThreadEvents">;
  readonly cursors: ReadonlyArray<{ readonly threadId: string; readonly afterSequence: number }>;
  readonly pageSize?: number;
}): Generator<T3SourceEventRow> {
  const pageSize = input.pageSize ?? 200;
  interface Cursor {
    readonly threadId: string;
    afterSequence: number;
    buffer: ReadonlyArray<T3SourceEventRow>;
    index: number;
    exhausted: boolean;
  }
  const fill = (cursor: Cursor) => {
    if (cursor.index < cursor.buffer.length || cursor.exhausted) return;
    const page = input.database.readThreadEvents({
      threadId: cursor.threadId,
      afterSequence: cursor.afterSequence,
      limit: pageSize,
    });
    cursor.buffer = page;
    cursor.index = 0;
    if (page.length < pageSize) cursor.exhausted = true;
    const last = page.at(-1);
    if (last !== undefined) cursor.afterSequence = last.sequence;
  };
  // A binary min-heap on each cursor's next sequence.
  const heap: Array<Cursor> = [];
  const head = (cursor: Cursor) => cursor.buffer[cursor.index]!.sequence;
  const swap = (a: number, b: number) => {
    const held = heap[a]!;
    heap[a] = heap[b]!;
    heap[b] = held;
  };
  const up = (start: number) => {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (head(heap[parent]!) <= head(heap[index]!)) break;
      swap(parent, index);
      index = parent;
    }
  };
  const down = (start: number) => {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && head(heap[left]!) < head(heap[smallest]!)) smallest = left;
      if (right < heap.length && head(heap[right]!) < head(heap[smallest]!)) smallest = right;
      if (smallest === index) return;
      swap(smallest, index);
      index = smallest;
    }
  };
  for (const start of input.cursors) {
    const cursor: Cursor = {
      threadId: start.threadId,
      afterSequence: start.afterSequence,
      buffer: [],
      index: 0,
      exhausted: false,
    };
    fill(cursor);
    if (cursor.index < cursor.buffer.length) {
      heap.push(cursor);
      up(heap.length - 1);
    }
  }
  while (heap.length > 0) {
    const cursor = heap[0]!;
    yield cursor.buffer[cursor.index]!;
    cursor.index += 1;
    fill(cursor);
    if (cursor.index < cursor.buffer.length) {
      down(0);
    } else {
      const last = heap.pop()!;
      if (heap.length > 0 && last !== cursor) {
        heap[0] = last;
        down(0);
      }
    }
  }
}
