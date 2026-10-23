import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Portable repository identity: the normalized remote (`host/owner/repo`,
  // null for a local-only repository) and the repository's directory name
  // under the project folder. Filled on link and clone, backfilled lazily
  // from the checkout's git remote on read.
  yield* sql`ALTER TABLE label_repositories ADD COLUMN remote TEXT`;
  yield* sql`ALTER TABLE label_repositories ADD COLUMN directory_name TEXT`;
});
