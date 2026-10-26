import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A separate preference records an opt-out even before an offline peer supplies its key.
  yield* sql`CREATE TABLE vault_peer_sharing_preferences (
    environment_id TEXT PRIMARY KEY,
    pairing_key TEXT NOT NULL,
    enabled INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO vault_peer_sharing_preferences(environment_id, pairing_key, enabled)
    SELECT environment_id, pairing_key, 0 FROM vault_peer_shares WHERE sharing_enabled = 0`;
});
