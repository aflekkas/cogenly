import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every document belongs to one source row. Triggers run inside its existing
// transaction, including projection repair and deletes. No subscriber can miss a write.
const sources = [
  {
    table: "orchestration_v2_projection_threads",
    key: "thread_id",
    prefix: "thread:",
    select: `SELECT 'thread:' || thread_id AS key, 'thread' AS kind, thread_id AS id,
      thread_id, title, '' AS body, updated_at AS matched_at
      FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`,
    updates: "title, deleted_at",
  },
  {
    table: "orchestration_v2_projection_messages",
    key: "message_id",
    prefix: "message:",
    select: `SELECT 'message:' || message_id AS key, 'thread' AS kind, thread_id AS id,
      thread_id, '' AS title, coalesce(json_extract(payload_json, '$.text'), '') AS body,
      created_at AS matched_at FROM orchestration_v2_projection_messages
      WHERE role IN ('user', 'assistant') AND streaming = 0 AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id = orchestration_v2_projection_messages.thread_id AND t.deleted_at IS NULL)`,
    updates: "payload_json, role, streaming, thread_id",
  },
  {
    table: "agents",
    key: "agent_id",
    prefix: "agent:",
    select: `SELECT 'agent:' || agent_id AS key, 'agent' AS kind, agent_id AS id,
      conversation_thread_id AS thread_id, json_extract(payload_json, '$.name') AS title,
      coalesce(json_extract(payload_json, '$.responsibility'), '') || ' ' ||
      coalesce(json_extract(payload_json, '$.instructions'), '') AS body,
      json_extract(payload_json, '$.updatedAt') AS matched_at FROM agents`,
    updates: "payload_json, conversation_thread_id",
  },
  {
    table: "commitments",
    key: "id",
    prefix: "commitment:",
    select: `SELECT 'commitment:' || id AS key, 'commitment' AS kind, id,
      NULL AS thread_id, json_extract(payload_json, '$.title') AS title,
      coalesce(json_extract(payload_json, '$.description'), '') AS body, updated_at AS matched_at FROM commitments`,
    updates: "payload_json",
  },
  {
    table: "project_labels",
    key: "label_id",
    prefix: "project:",
    select: `SELECT 'project:' || label_id AS key, 'project' AS kind, label_id AS id,
      NULL AS thread_id, name AS title, coalesce(description, '') AS body,
      updated_at AS matched_at FROM project_labels`,
    updates: "name, description",
  },
] as const;
const columns = "key, kind, id, thread_id, title, body, matched_at";
// PR links live in the V2 thread payload, not the legacy PR projection table.
const prs = (
  where: string,
) => `SELECT 'pr:' || t.thread_id || ':' || json_extract(p.value, '$.url'),
  'pr', json_extract(p.value, '$.url'), t.thread_id,
  coalesce(json_extract(p.value, '$.snapshot.title'), json_extract(p.value, '$.url')),
  json_extract(p.value, '$.url'),
  coalesce(json_extract(p.value, '$.snapshot.updatedAt'), json_extract(p.value, '$.linkedAt'), t.updated_at)
  FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.pullRequests') p
  WHERE t.deleted_at IS NULL AND json_extract(p.value, '$.source') <> 'stack-dismissed' ${where}`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE search_documents (
    rowid INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    id TEXT NOT NULL, thread_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, matched_at TEXT
  )`;
  yield* sql`CREATE INDEX search_documents_thread ON search_documents(thread_id)`;
  yield* sql`CREATE INDEX search_documents_entity ON search_documents(kind, id)`;
  const fts =
    yield* sql`CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_documents', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`.pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  yield* sql`CREATE TABLE search_config (engine TEXT NOT NULL)`;
  yield* sql`INSERT INTO search_config VALUES (${fts ? "fts5" : "like-prefix"})`;
  if (fts) {
    yield* sql`CREATE TRIGGER search_documents_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid, title, body) VALUES (NEW.rowid, NEW.title, NEW.body); END`;
    yield* sql`CREATE TRIGGER search_documents_delete AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', OLD.rowid, OLD.title, OLD.body); END`;
    yield* sql`CREATE TRIGGER search_documents_update AFTER UPDATE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', OLD.rowid, OLD.title, OLD.body);
      INSERT INTO search_fts(rowid, title, body) VALUES (NEW.rowid, NEW.title, NEW.body); END`;
  } else {
    // Prefix LIKE keeps these indexes usable without duplicating long bodies in
    // B-trees on FTS builds. This fallback matches field prefixes, not substrings.
    yield* sql`CREATE INDEX search_documents_title ON search_documents(title COLLATE NOCASE)`;
    yield* sql`CREATE INDEX search_documents_body ON search_documents(body COLLATE NOCASE)`;
    yield* Effect.logWarning(
      "SQLite FTS5 unavailable; global search uses indexed title/body prefix LIKE.",
    );
  }
  for (const source of sources) {
    const selected = `${source.select} ${source.select.includes(" WHERE ") ? "AND" : "WHERE"} ${source.key} = NEW.${source.key}`;
    const insert = `INSERT INTO search_documents(${columns}) ${selected};`;
    // Explicit DELETE + INSERT avoids REPLACE's optional recursive delete triggers.
    yield* sql.unsafe(`CREATE TRIGGER search_${source.table}_insert AFTER INSERT ON ${source.table} BEGIN
      DELETE FROM search_documents WHERE key = '${source.prefix}' || NEW.${source.key}; ${insert} END`);
    const changed =
      source.table === "orchestration_v2_projection_threads"
        ? "NEW.title IS NOT OLD.title OR NEW.deleted_at IS NOT OLD.deleted_at"
        : source.table === "orchestration_v2_projection_messages"
          ? "NEW.thread_id IS NOT OLD.thread_id OR NEW.role IS NOT OLD.role OR NEW.streaming IS NOT OLD.streaming OR (NEW.streaming = 0 AND json_extract(NEW.payload_json, '$.text') IS NOT json_extract(OLD.payload_json, '$.text'))"
          : "NEW." +
            (source.table === "project_labels"
              ? "name IS NOT OLD.name OR NEW.description IS NOT OLD.description"
              : "payload_json IS NOT OLD.payload_json");
    yield* sql.unsafe(`CREATE TRIGGER search_${source.table}_update AFTER UPDATE OF ${source.updates} ON ${source.table} WHEN ${changed} BEGIN
      DELETE FROM search_documents WHERE key = '${source.prefix}' || OLD.${source.key}; ${insert} END`);
    yield* sql.unsafe(`CREATE TRIGGER search_${source.table}_delete AFTER DELETE ON ${source.table} BEGIN
      DELETE FROM search_documents WHERE key = '${source.prefix}' || OLD.${source.key}; END`);
    // Keyset batches bound memory and statement size; the migration ledger makes
    // this a one-time backfill. UPSERT makes each batch safe to repeat.
    let after = "";
    while (true) {
      const keys = yield* sql.unsafe<{ key: string }>(
        `SELECT ${source.key} AS key FROM ${source.table}
        WHERE ${source.key} > ? ORDER BY ${source.key} LIMIT 250`,
        [after],
      );
      const last = keys.at(-1)?.key;
      if (last === undefined) break;
      yield* sql.unsafe(
        `INSERT INTO search_documents(${columns}) ${source.select}
        ${source.select.includes(" WHERE ") ? "AND" : "WHERE"} ${source.key} > ? AND ${source.key} <= ?
        ON CONFLICT(key) DO UPDATE SET title=excluded.title, body=excluded.body, matched_at=excluded.matched_at`,
        [after, last],
      );
      after = last;
    }
  }
  for (const [name, event] of [
    ["insert", "INSERT"],
    ["update", "UPDATE OF payload_json, deleted_at"],
    ["delete", "DELETE"],
  ] as const) {
    yield* sql.unsafe(`CREATE TRIGGER search_pr_${name} AFTER ${event} ON orchestration_v2_projection_threads
      ${name === "update" ? "WHEN NEW.deleted_at IS NOT OLD.deleted_at OR json_extract(NEW.payload_json, '$.pullRequests') IS NOT json_extract(OLD.payload_json, '$.pullRequests')" : ""} BEGIN
      DELETE FROM search_documents WHERE kind = 'pr' AND thread_id = ${name === "insert" ? "NEW" : "OLD"}.thread_id;
      ${name === "delete" ? "" : `INSERT INTO search_documents(${columns}) ${prs("AND t.thread_id = NEW.thread_id")};`} END`);
  }
  // A soft delete removes the transcript documents too. Restore/replay reinserts
  // messages through their ordinary projection writes.
  yield* sql`CREATE TRIGGER search_thread_deleted AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN DELETE FROM search_documents WHERE thread_id = NEW.thread_id AND kind IN ('thread', 'pr'); END`;
  yield* sql`CREATE TRIGGER search_thread_removed AFTER DELETE ON orchestration_v2_projection_threads
    BEGIN DELETE FROM search_documents WHERE thread_id = OLD.thread_id AND kind IN ('thread', 'pr'); END`;
  yield* sql`CREATE TRIGGER search_repository_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
      DELETE FROM search_documents WHERE kind IN ('thread', 'pr') AND thread_id IN
        (SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = NEW.project_id); END`;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id > ${after} ORDER BY thread_id LIMIT 250`;
    const last = rows.at(-1)?.thread_id;
    if (last === undefined) break;
    yield* sql.unsafe(
      `INSERT OR IGNORE INTO search_documents(${columns}) ${prs("AND t.thread_id > ? AND t.thread_id <= ?")}`,
      [after, last],
    );
    after = last;
  }
});
