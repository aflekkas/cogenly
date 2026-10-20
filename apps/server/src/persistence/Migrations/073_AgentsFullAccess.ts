import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Agents reach every project at full autonomy; per-project grants and the
  // autonomy level no longer exist, so drop them from stored agent policy.
  yield* sql`UPDATE agents SET payload_json = json_remove(payload_json, '$.scope', '$.autonomy', '$.paused', '$.enabled', '$.pauseReason')`;
});
