import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Document kinds are validated by readers; preserve all kinds added by other features.
  yield* sql`CREATE TABLE shared_documents_next (
    kind TEXT NOT NULL, id TEXT NOT NULL,
    fields_json TEXT NOT NULL, clocks_json TEXT NOT NULL, tombstone_json TEXT,
    updated_by_env TEXT NOT NULL, PRIMARY KEY(kind,id)
  )`;
  yield* sql`INSERT INTO shared_documents_next SELECT kind,id,fields_json,clocks_json,tombstone_json,updated_by_env FROM shared_documents`;
  yield* sql`DROP TABLE shared_documents`;
  yield* sql`ALTER TABLE shared_documents_next RENAME TO shared_documents`;
  // The last value SettingsSync reconciled between settings.json and a shared
  // settings document, per key; scope is '' for universal keys or the local
  // repository id a project override was applied to.
  yield* sql`CREATE TABLE settings_sync_base (
    document_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(document_id, scope, key)
  )`;
});
