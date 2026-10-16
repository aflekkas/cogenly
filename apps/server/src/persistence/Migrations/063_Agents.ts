import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY, conversation_thread_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    backoff_until TEXT, pause_reason TEXT, enabled INTEGER NOT NULL,
    daily_run_cap INTEGER NOT NULL DEFAULT 100, run_day TEXT, daily_runs INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE agent_memory (
    note_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    text TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, note_id)
  )`;
  yield* sql`CREATE INDEX agent_memory_recent ON agent_memory(agent_id, updated_at DESC, note_id)`;
  yield* sql`CREATE TABLE agent_conversation_context (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    summary TEXT NOT NULL, covered_run_ordinal INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_work_runs (
    run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    trigger_id TEXT NOT NULL, work_thread_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, summary TEXT,
    posted INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX agent_work_runs_agent ON agent_work_runs(agent_id, created_at DESC)`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE`;
  yield* sql`CREATE INDEX scheduled_tasks_agent ON scheduled_tasks(agent_id)`;
  yield* migrateLegacyAgents;
});

export const migrateLegacyAgents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Group multiple legacy triggers bound to the same thread into one identity.
  yield* sql`INSERT OR IGNORE INTO agents(agent_id, conversation_thread_id, payload_json, enabled)
    SELECT 'agent:legacy:' || task_id, thread_id,
      json_object('id', 'agent:legacy:' || task_id, 'name', title,
        'avatar', json_object('seed', thread_id), 'instructions', prompt,
        'modelSelection', json(model_selection_json), 'runtimeMode', runtime_mode,
        'projectId', project_id, 'enabled', json(CASE WHEN (SELECT MAX(s.enabled) FROM scheduled_tasks s WHERE s.thread_id = scheduled_tasks.thread_id) = 1 THEN 'true' ELSE 'false' END),
        'dailyRunCap', 100, 'conversationThreadId', thread_id, 'createdAt', created_at, 'updatedAt', updated_at),
      (SELECT MAX(s.enabled) FROM scheduled_tasks s WHERE s.thread_id = scheduled_tasks.thread_id)
    FROM scheduled_tasks WHERE thread_id IS NOT NULL ORDER BY created_at, task_id`;
  yield* sql`UPDATE scheduled_tasks SET agent_id = (
    SELECT agent_id FROM agents WHERE conversation_thread_id = scheduled_tasks.thread_id
  ) WHERE agent_id IS NULL AND thread_id IS NOT NULL`;
});
