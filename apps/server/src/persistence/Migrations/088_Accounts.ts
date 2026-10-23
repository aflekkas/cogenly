import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Metadata-only backfill; deterministic ids preserve legacy vault references. */
export const migrateVaultAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO accounts(id, scope_project_id, payload_json)
    SELECT 'account:' || id, scope_project_id,
      json_object('id', 'account:' || id, 'serviceId', 'other',
        'displayLabel', 'Other credentials', 'scopeProjectId', scope_project_id,
        'credentials', json_array(json_object('id', 'credential:' || id,
          'kind', CASE type WHEN 'login' THEN 'login' WHEN 'api_key' THEN 'token' ELSE 'key_set' END,
          'vaultItemId', id, 'portability', 'shared',
          'deliveryBindings', json(CASE type WHEN 'login' THEN '["browser"]' ELSE '[]' END),
          'policy', json('{"processExposure":"ask"}'))), 'integrationIds', json('[]'))
    FROM vault_items WHERE deleted_at IS NULL`;
  yield* sql`INSERT OR IGNORE INTO account_credentials(id, account_id, vault_item_id)
    SELECT json_extract(c.value, '$.id'), a.id, json_extract(c.value, '$.vaultItemId')
    FROM accounts a, json_each(a.payload_json, '$.credentials') c
    WHERE a.deleted_at IS NULL AND json_extract(c.value, '$.vaultItemId') IS NOT NULL`;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE accounts(id TEXT PRIMARY KEY, scope_project_id TEXT, payload_json TEXT NOT NULL, deleted_at TEXT)`;
  yield* sql`CREATE TABLE account_credentials(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), vault_item_id TEXT UNIQUE)`;
  yield* sql`CREATE TABLE account_machine_status(credential_id TEXT NOT NULL, environment_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(credential_id, environment_id))`;
  yield* migrateVaultAccounts;
});
