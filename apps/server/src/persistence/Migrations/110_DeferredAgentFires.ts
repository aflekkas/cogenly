import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE deferred_agent_fires (
    fire_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    task_created_at TEXT NOT NULL,
    prompt TEXT NOT NULL,
    manual INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
