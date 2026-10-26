import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_continuity_epoch (installed_at TEXT NOT NULL)`;
  yield* sql`INSERT INTO agent_continuity_epoch VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
  yield* sql`CREATE TABLE agent_inbox_sweeps (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    run_id TEXT PRIMARY KEY, text TEXT NOT NULL, model_selection_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE agent_handoff_narratives (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    covered_run_ordinal INTEGER NOT NULL, narrative TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, covered_run_ordinal)
  )`;
  yield* sql`CREATE TABLE agent_handoff_briefs (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    version INTEGER NOT NULL, covered_run_ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(agent_id, version)
  )`;
});
