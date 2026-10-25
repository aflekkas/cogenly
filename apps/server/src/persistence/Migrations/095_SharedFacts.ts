import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Document kinds are validated by the build that reads them (an unknown one
  // waits in shared_deferred_changes), so the table no longer lists them.
  yield* sql`CREATE TABLE shared_documents_next (
    kind TEXT NOT NULL, id TEXT NOT NULL,
    fields_json TEXT NOT NULL, clocks_json TEXT NOT NULL, tombstone_json TEXT,
    updated_by_env TEXT NOT NULL, PRIMARY KEY(kind,id)
  )`;
  yield* sql`INSERT INTO shared_documents_next SELECT kind,id,fields_json,clocks_json,tombstone_json,updated_by_env FROM shared_documents`;
  yield* sql`DROP TABLE shared_documents`;
  yield* sql`ALTER TABLE shared_documents_next RENAME TO shared_documents`;
  // Local bookkeeping for facts projected from shared documents. Copies of one
  // normalized fact share a dedupe key; a copy hidden behind the winning one
  // records it in duplicate_of, so its status is not mistaken for its own.
  yield* sql`ALTER TABLE facts ADD COLUMN dedupe_key TEXT`;
  yield* sql`ALTER TABLE facts ADD COLUMN duplicate_of TEXT`;
  yield* sql`CREATE INDEX facts_dedupe_key ON facts(dedupe_key) WHERE dedupe_key IS NOT NULL`;
  yield* sql`CREATE INDEX facts_duplicate_of ON facts(duplicate_of) WHERE duplicate_of IS NOT NULL`;
});
