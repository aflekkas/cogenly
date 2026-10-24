import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Commands order a thread's messages by their first turn item and look up a
  // message's item by message ID. Without this index both scanned every message
  // item of the thread and parsed its payload. Queries must repeat the type
  // predicate and the json_extract expression exactly for SQLite to use it.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_message_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message')
  `;

  // Delegated completion delivery reads only the subagents its parent run spawned.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_run_idx
    ON orchestration_v2_projection_subagents(run_id)
  `;
});
