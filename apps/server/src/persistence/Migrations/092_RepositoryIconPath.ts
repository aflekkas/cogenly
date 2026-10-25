import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The icon file a checkout of the repository resolved, relative to its root;
// synced with the project so machines without a checkout show it too.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE label_repositories ADD COLUMN icon_path TEXT`;
});
