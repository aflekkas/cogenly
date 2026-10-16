import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agents ADD COLUMN last_read_at TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE agents ADD COLUMN last_read_message_id TEXT NOT NULL DEFAULT ''`;
  yield* sql`CREATE INDEX agent_messages_unread ON orchestration_v2_projection_messages(thread_id, updated_at, message_id) WHERE role = 'assistant' AND streaming = 0`;
});
