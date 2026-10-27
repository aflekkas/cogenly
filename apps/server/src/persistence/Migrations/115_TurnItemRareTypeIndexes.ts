import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 114's full (type, updated_at) index outranked the recovery and
  // shell pending partial indexes, so startup recovery and every shell load
  // read each tool-call row (4 to 8 s cold on a 10 GB database). Partial
  // indexes keep the rare-type sweeps fast without competing for those plans.
  // One per type: SQLite does not match `type = 'error'` to an IN (...) index.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_type_updated_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_error_updated_idx
    ON orchestration_v2_projection_turn_items(updated_at) WHERE type = 'error'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_secret_request_idx
    ON orchestration_v2_projection_turn_items(thread_id) WHERE type = 'secret_request'
  `;
});
