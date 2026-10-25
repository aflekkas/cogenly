import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a newer peer sent that this build cannot read yet: a document kind it
  // does not know, or a known field whose value it cannot validate. Kept
  // verbatim and retried at startup, so an update applies it without a resync.
  yield* sql`CREATE TABLE shared_deferred_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    source_env TEXT NOT NULL,
    trusted_relay INTEGER NOT NULL CHECK(trusted_relay IN (0,1)),
    change_json TEXT NOT NULL
  )`;
  // Replicated thread events or metadata this build cannot decode. A thread
  // with any held item holds every later one, in order, so it never applies
  // out of sequence; other threads keep syncing.
  yield* sql`CREATE TABLE thread_replication_deferred (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    item_kind TEXT NOT NULL CHECK(item_kind IN ('meta','event')),
    source_env TEXT NOT NULL,
    trusted_relay INTEGER NOT NULL CHECK(trusted_relay IN (0,1)),
    item_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX thread_replication_deferred_thread ON thread_replication_deferred(thread_id, seq)`;
});
