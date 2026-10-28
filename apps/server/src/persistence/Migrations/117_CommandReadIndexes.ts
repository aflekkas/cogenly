import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { maintenanceMessageOrder } from "../../orchestration-v2/MessageDispatchContext.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Dispatch selects a fixed set of historical run summaries, plus live work.
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_executed_idx
    ON orchestration_v2_projection_runs(thread_id,
      COALESCE(json_extract(payload_json, '$.completedAt'), '9999') DESC, ordinal DESC)
    WHERE status <> 'queued' AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_status_ordinal_idx
    ON orchestration_v2_projection_runs(thread_id, status, ordinal DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_root_error_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC)
    WHERE type = 'error' AND status = 'failed'`;
  yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_history_witness_idx
    ON orchestration_v2_projection_messages(thread_id, (${maintenanceMessageOrder}), created_at, message_id)
    WHERE role = 'user'`);

  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_node_idx
    ON orchestration_v2_projection_provider_turns(node_id, provider_thread_id, ordinal)`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoint_scopes_run_idx
    ON orchestration_v2_projection_checkpoint_scopes(run_id, ordinal_within_parent, scope_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_live_idx
    ON orchestration_v2_projection_subagents(thread_id)
    WHERE status IN ('pending','starting','running','waiting')`;

  // Command intake filters out tool output. Cover the predicates so SQLite
  // never reads those large historical payloads just to reject their rows.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, ordinal, turn_item_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_command_idx
    ON orchestration_v2_projection_nodes(thread_id, kind, status, run_id, started_at, node_id)
  `;
});
