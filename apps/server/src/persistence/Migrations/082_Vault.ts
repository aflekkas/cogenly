import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Metadata, policy and allowed domains are plaintext; every secret field is
  // in `ciphertext`, encrypted with a data key wrapped per machine in
  // `wrapped_keys_json`. Deletes are tombstones so replicas can learn them.
  yield* sql`CREATE TABLE vault_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    scope_project_id TEXT,
    metadata_json TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    allowed_domains_json TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    wrapped_keys_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX vault_items_scope_name
    ON vault_items (COALESCE(scope_project_id, ''), name) WHERE deleted_at IS NULL`;
  yield* sql`CREATE INDEX vault_items_scope ON vault_items (scope_project_id, updated_at DESC)`;
  yield* sql`CREATE TABLE vault_usage (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    thread_id TEXT,
    agent_id TEXT,
    action TEXT NOT NULL,
    domain TEXT,
    at TEXT NOT NULL,
    outcome TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX vault_usage_item ON vault_usage (item_id, at DESC)`;
  yield* sql`CREATE INDEX vault_usage_recent ON vault_usage (at DESC)`;
});
