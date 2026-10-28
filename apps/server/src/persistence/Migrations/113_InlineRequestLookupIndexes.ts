import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Cleanup must still find a committed parent link if its projection was lost.
  // That fallback used to scan the entire event log for each abandoned child.
  yield* sql`
    CREATE INDEX orchestration_events_delegated_child_idx
    ON orchestration_events(json_extract(payload_json, '$.childThreadId'))
    WHERE event_type = 'subagent.updated'
      AND json_extract(payload_json, '$.origin') = 'app_owned'
  `;
  // Background card discovery must never walk command output or message history.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_secret_status_idx
    ON orchestration_v2_projection_turn_items(
      json_extract(payload_json, '$.secretStatus'), thread_id
    ) WHERE type = 'secret_request'
  `;
  // Health runs frequently. Restrict its time window using only rate-limit errors.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_rate_limit_idx
    ON orchestration_v2_projection_turn_items(updated_at, thread_id, run_id)
    WHERE type = 'error' AND (
      json_extract(payload_json, '$.failure.limitKind') = 'rate_limit'
      OR json_extract(payload_json, '$.failure.code') = 'rateLimitExceeded'
    )
  `;
});
