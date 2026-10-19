import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Schedule JSON already supports extending the trigger union. Keep identity,
  // approval, deletion and subscriptions on scheduled_tasks, rather than a sibling.
  yield* sql`CREATE TABLE agent_events (
    event_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, attempted_at TEXT
  )`;
  yield* sql`CREATE TABLE agent_event_deliveries (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    event_key TEXT NOT NULL REFERENCES agent_events(event_key),
    work_thread_id TEXT NOT NULL, context_json TEXT NOT NULL,
    PRIMARY KEY(agent_id, event_key), UNIQUE(work_thread_id)
  )`;
  yield* sql`CREATE INDEX agent_events_pending ON agent_events(dispatched, attempted_at, occurred_at, event_key)`;
  yield* sql`ALTER TABLE commitments ADD COLUMN source_thread_id TEXT`;
  yield* sql`CREATE TABLE agent_event_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL)`;
  // Historical work predating this feature must not wake agents on upgrade.
  yield* sql`INSERT INTO agent_event_cursor VALUES (1, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events))`;
  yield* sql`ALTER TABLE agent_work_runs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'trigger'`;
  yield* sql`ALTER TABLE agent_work_runs ADD COLUMN trigger_context_json TEXT`;
});
