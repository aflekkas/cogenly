import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Cogenly-managed integrations: upstream MCP servers behind the gateway.
  // The full definition lives in payload_json; name is the agent-facing slug.
  // deleted_at is the tombstone shared documents will replicate later.
  yield* sql`CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    deleted_at TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX integrations_live_name ON integrations(name) WHERE deleted_at IS NULL`;
});
