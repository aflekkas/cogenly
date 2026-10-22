import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Ledger for Import from T3 Code. One row per imported T3 thread records the
// last T3 event sequence written, so a re-run appends only newer events and
// never duplicates. Projects record which Cogenly project each T3 project
// landed in.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3_import_threads (
    source_thread_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_last_sequence INTEGER NOT NULL,
    imported_events INTEGER NOT NULL,
    first_imported_at TEXT NOT NULL,
    last_imported_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE t3_import_projects (
    source_project_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    action TEXT NOT NULL,
    imported_at TEXT NOT NULL
  )`;
});
