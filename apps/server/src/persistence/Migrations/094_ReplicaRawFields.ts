import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Replicated events as another machine sent them, kept only when this
  // build's decoding dropped fields, so relaying or moving the thread on
  // passes those fields along.
  yield* sql`CREATE TABLE thread_replication_raw_events (
    event_id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL
  )`;
  // Thread metadata keys from a newer owner that this build does not know.
  yield* sql`ALTER TABLE thread_owners ADD COLUMN meta_extra_json TEXT`;
});
