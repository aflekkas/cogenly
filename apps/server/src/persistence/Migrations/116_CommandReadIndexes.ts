import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Command intake filters out tool output. Cover the predicates so SQLite
  // never reads those large historical payloads just to reject their rows.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, ordinal, turn_item_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_command_idx
    ON orchestration_v2_projection_nodes(thread_id, kind, status, run_id, started_at, node_id)
  `;
});
