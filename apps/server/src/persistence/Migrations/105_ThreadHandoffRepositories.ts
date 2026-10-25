import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Pin retries to the same source commit and retain preservation reports after a lost reply.
  yield* sql`CREATE TABLE thread_handoff_repositories (
    thread_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    repository_json TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (thread_id, epoch)
  )`;
});
