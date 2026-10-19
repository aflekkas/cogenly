import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Agents can no longer be paused, by the owner or after repeated failures.
  // `enabled` now only fences background starts while an agent is being deleted.
  yield* sql`UPDATE agents SET enabled = 1, pause_reason = NULL, consecutive_failures = 0, backoff_until = NULL WHERE enabled = 0`;
});
