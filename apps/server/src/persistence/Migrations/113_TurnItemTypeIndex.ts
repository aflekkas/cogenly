import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Health and integration sweeps look up rare item types across every thread.
  // Without this they scan every transcript item, seconds on a large database.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_type_updated_idx
    ON orchestration_v2_projection_turn_items(type, updated_at)
  `;
});
