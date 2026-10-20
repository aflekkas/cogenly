import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing agents retain the old MCP capability ceiling. Runtime/interaction checks
  // still apply, including provider approvals for approval-required agents. No label
  // grants are inferred from tags or repository membership. Newly created agents use
  // propose + read/draft instead. New triggers always require explicit owner approval.
  yield* sql`UPDATE agents SET payload_json = json_set(payload_json,
    '$.responsibility', '', '$.scope', json('[]'),
    '$.autonomy', 'autonomous_within_policy',
    '$.permissions', json('{"read":true,"draft":true,"execute":true,"send":true,"create_pr":true,"merge":true,"deploy":true,"delete":true}'),
    '$.notifyPolicy', 'all', '$.paused', json(CASE WHEN enabled = 1 THEN 'false' ELSE 'true' END))`;
  yield* sql`CREATE TABLE agent_approvals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    action_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
    requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, source_run_id TEXT, result_thread_id TEXT
  )`;
  yield* sql`CREATE INDEX agent_approvals_agent ON agent_approvals(agent_id, status, requested_at)`;
  yield* sql`CREATE TABLE commitments (
    id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
    status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE commitment_labels (
    commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE, PRIMARY KEY(commitment_id, label_id)
  )`;
  yield* sql`CREATE INDEX commitment_labels_label ON commitment_labels(label_id, commitment_id)`;
  yield* sql`CREATE INDEX commitments_filter ON commitments(agent_id, status, updated_at)`;
  yield* sql`CREATE TABLE commitment_history (
    id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX commitment_history_item ON commitment_history(commitment_id)`;
  yield* sql`CREATE TABLE agent_run_threads (
    thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    trigger_kind TEXT NOT NULL, source_run_id TEXT
  )`;
  yield* sql`CREATE TABLE agent_run_actions (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id TEXT, kind TEXT NOT NULL, target_id TEXT, at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_run_actions_agent ON agent_run_actions(agent_id, at DESC)`;
});
