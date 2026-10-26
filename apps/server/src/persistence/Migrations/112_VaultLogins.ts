import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Several logins for one site share its name and differ by label and
  // username (checked by the Vault service), so names stay unique only
  // among other item types. Existing items keep their names.
  yield* sql`DROP INDEX IF EXISTS vault_items_scope_name`;
  yield* sql`CREATE UNIQUE INDEX vault_items_scope_name
    ON vault_items (COALESCE(scope_project_id, ''), name)
    WHERE deleted_at IS NULL AND type <> 'login'`;
  yield* sql`CREATE INDEX vault_items_scope_login_name
    ON vault_items (COALESCE(scope_project_id, ''), name)
    WHERE deleted_at IS NULL AND type = 'login'`;
  // Which integrations a login signs in to. Local, like an item's policy:
  // integrations are set up per machine.
  yield* sql`CREATE TABLE vault_login_integrations (
    item_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (item_id, integration_id)
  )`;
  yield* sql`CREATE INDEX vault_login_integrations_integration
    ON vault_login_integrations (integration_id)`;
  // The default rule moved from "ask first" to "any agent on the item's
  // allowed sites". An old-default rule (ask, no agent, thread or domain
  // lists) cannot be told apart from an owner who picked "Ask first" in
  // Settings, so every such rule moves. Integration token items keep theirs:
  // the gateway writes them with an explicit ask, and they carry a sync
  // attachment no owner-saved item has.
  yield* sql`UPDATE vault_items
    SET policy_json = json_set(policy_json, '$.mode', 'allow')
    WHERE deleted_at IS NULL
      AND sync_attachment_json IS NULL
      AND json_valid(policy_json)
      AND json_extract(policy_json, '$.mode') = 'ask'
      AND json_array_length(COALESCE(json_extract(policy_json, '$.allowedAgentIds'), '[]')) = 0
      AND json_array_length(COALESCE(json_extract(policy_json, '$.allowedThreadIds'), '[]')) = 0
      AND json_array_length(COALESCE(json_extract(policy_json, '$.allowedDomains'), '[]')) = 0
      AND COALESCE(json_extract(policy_json, '$.ownerSet'), 0) = 0`;
});
