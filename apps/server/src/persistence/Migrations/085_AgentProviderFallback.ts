import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Which provider instance + model a work run actually used, and why it
  // fell back. The agent's own fallback state lives in its payload_json.
  yield* sql`ALTER TABLE agent_work_runs ADD COLUMN model_selection_json TEXT`;
  yield* sql`ALTER TABLE agent_work_runs ADD COLUMN fallback_reason TEXT`;
  yield* sql`ALTER TABLE agent_work_runs ADD COLUMN fallback_reset_at TEXT`;
});
