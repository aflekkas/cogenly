import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The owner's decision to share this vault with one directly paired machine,
  // and that machine's vault key as it presented it over the link. The
  // pairing key ties the decision to one pairing; re-pairing drops it.
  yield* sql`CREATE TABLE vault_peer_shares (
    environment_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    pairing_key TEXT NOT NULL,
    authorized_at TEXT NOT NULL
  )`;
  // The revision of each synced vault document this machine last projected
  // or wrote, and whether it could read it. `local_name` is the name the item
  // has here when an incoming one collided with a local item.
  yield* sql`CREATE TABLE vault_sync_applied (
    item_id TEXT PRIMARY KEY,
    sealed_digest TEXT,
    state TEXT NOT NULL CHECK(state IN ('applied','waiting','deleted')),
    local_name TEXT
  )`;
  yield* sql`ALTER TABLE vault_items ADD COLUMN portability TEXT NOT NULL DEFAULT 'shared' CHECK(portability IN ('shared','machine'))`;
  // Non-secret state other features keep with an item and sync inside its payload.
  yield* sql`ALTER TABLE vault_items ADD COLUMN sync_attachment_json TEXT`;
});
