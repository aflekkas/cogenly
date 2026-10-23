import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE vault_items ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 1`;
  yield* sql`CREATE TABLE account_thread_bindings(thread_id TEXT NOT NULL, credential_id TEXT NOT NULL, account_id TEXT NOT NULL, project_key TEXT NOT NULL, PRIMARY KEY(thread_id, credential_id))`;
  yield* sql`CREATE TABLE account_process_grants(credential_id TEXT NOT NULL, credential_revision INTEGER NOT NULL, project_key TEXT NOT NULL, subject_type TEXT NOT NULL CHECK(subject_type IN ('thread','agent')), subject_id TEXT NOT NULL, PRIMARY KEY(credential_id, project_key, subject_type, subject_id))`;
  // Ordinary owner-started threads also need process-exposure consent. They have no
  // persistent agent record; keep those approvals in the same owner decision flow.
  yield* sql`ALTER TABLE agent_approvals RENAME TO agent_approvals_before_accounts`;
  yield* sql`DROP INDEX agent_approvals_agent`;
  yield* sql`CREATE TABLE agent_approvals(id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE, action_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')), requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, source_run_id TEXT, result_thread_id TEXT)`;
  yield* sql`INSERT INTO agent_approvals SELECT * FROM agent_approvals_before_accounts`;
  yield* sql`DROP TABLE agent_approvals_before_accounts`;
  yield* sql`CREATE INDEX agent_approvals_agent ON agent_approvals(agent_id, status, requested_at)`;
  for (const column of [
    "credential_id",
    "credential_revision",
    "environment_id",
    "project_id",
    "delivery_method",
    "terminal_id",
    "provider_instance_id",
  ]) {
    yield* sql.unsafe(`ALTER TABLE vault_usage ADD COLUMN ${column} TEXT`);
  }
  yield* sql`CREATE TABLE account_connections(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_instance_id TEXT NOT NULL, project_id TEXT NOT NULL, scope_project_id TEXT, service_id TEXT NOT NULL, display_label TEXT NOT NULL, account_id TEXT, credential_id TEXT, created_at TEXT NOT NULL, cancelled_at TEXT)`;
});
