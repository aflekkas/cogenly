import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Local journal: a crash between moving a directory and leaving its forwarding
  // link must not strand checkout/worktree paths. It never leaves this machine.
  yield* sql`CREATE TABLE project_merge_file_moves (
    source TEXT NOT NULL, target TEXT NOT NULL, directory INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source,target)
  )`;
});
