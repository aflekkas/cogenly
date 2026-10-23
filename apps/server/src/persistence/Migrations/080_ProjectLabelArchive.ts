import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // When the project was archived; null while it is active. Archiving only
  // hides the project from pickers, so its threads and filing stay as they are.
  yield* sql`ALTER TABLE project_labels ADD COLUMN archived_at TEXT`;
});
