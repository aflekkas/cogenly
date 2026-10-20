import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per interactive visual (its `html_render` tool result) in a
  // thread. The orchestration event `visual-state.updated` is the source of
  // truth; this table is its projection, read for the thread projection and
  // for version-checked writes.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_visual_states (
      thread_id TEXT NOT NULL,
      render_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, render_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_visual_states_thread
    ON orchestration_v2_projection_visual_states (thread_id)
  `;
});
