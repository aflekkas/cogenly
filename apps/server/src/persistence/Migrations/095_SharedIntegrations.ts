import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_documents_next (
    kind TEXT NOT NULL CHECK(kind IN ('project','agent','schedule','settings','project-settings','integration')), id TEXT NOT NULL,
    fields_json TEXT NOT NULL, clocks_json TEXT NOT NULL, tombstone_json TEXT,
    updated_by_env TEXT NOT NULL, PRIMARY KEY(kind,id)
  )`;
  yield* sql`INSERT INTO shared_documents_next SELECT kind,id,fields_json,clocks_json,tombstone_json,updated_by_env FROM shared_documents`;
  yield* sql`DROP TABLE shared_documents`;
  yield* sql`ALTER TABLE shared_documents_next RENAME TO shared_documents`;
  // Name aliases never travel back into the shared document. The version
  // makes materializing an unchanged document a no-op, including after restart.
  yield* sql`CREATE TABLE integration_sync_state (
    integration_id TEXT PRIMARY KEY, shared_name TEXT NOT NULL, local_name TEXT NOT NULL,
    applied_version TEXT NOT NULL
  )`;
});
