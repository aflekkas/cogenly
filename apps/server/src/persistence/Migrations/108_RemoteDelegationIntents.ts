import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A remote launch remains cancellable until its parent link commits. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE remote_delegation_intents (
    child_thread_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    command_id TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL
  )`;
});
