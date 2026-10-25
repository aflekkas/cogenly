import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Opting out revokes authorization, but the key remains pinned until unpairing.
  // Existing rows were authorized, so upgrades keep that decision.
  yield* sql`ALTER TABLE vault_peer_shares ADD COLUMN sharing_enabled INTEGER NOT NULL DEFAULT 1`;
});
