import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_documents (
    kind TEXT NOT NULL CHECK(kind IN ('project','agent','schedule')), id TEXT NOT NULL,
    fields_json TEXT NOT NULL, clocks_json TEXT NOT NULL, tombstone_json TEXT,
    updated_by_env TEXT NOT NULL, PRIMARY KEY(kind,id)
  )`;
  yield* sql`CREATE TABLE shared_changes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT, change_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_peer_cursors (
    environment_id TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0,
    acknowledged INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE shared_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), clock_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE shared_possible_duplicates (
    kind TEXT NOT NULL, first_id TEXT NOT NULL, second_id TEXT NOT NULL,
    PRIMARY KEY(kind,first_id,second_id)
  )`;
  // Filled with the stable environment identity before any scheduler starts.
  // SQL migrations intentionally do not read machine identity files.
  yield* sql`ALTER TABLE agents ADD COLUMN owner_machine TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_machine TEXT`;
});
