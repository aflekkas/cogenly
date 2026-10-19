import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE facts (
    id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(agent_id) ON DELETE CASCADE,
    legacy_note_id TEXT, legacy_source TEXT, status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','superseded','retracted')),
    payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX facts_owner_status ON facts(agent_id, status, updated_at)`;
  yield* sql`CREATE TABLE fact_labels (fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE, PRIMARY KEY(fact_id,label_id))`;
  yield* sql`CREATE INDEX fact_labels_label ON fact_labels(label_id, fact_id)`;
  yield* sql`CREATE TABLE fact_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX fact_history_fact ON fact_history(fact_id, sequence)`;
  yield* sql`CREATE TABLE thread_context_settings (thread_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`;
  yield* sql`CREATE TABLE context_refs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  // Preserve note ids, provenance, and trust. Agent-authored legacy notes are proposals.
  // Only explicit scope grants are migrated; a primary repo never implies a label grant.
  yield* sql`INSERT INTO facts(id,agent_id,legacy_note_id,legacy_source,status,payload_json,updated_at)
    SELECT 'legacy-memory:' || json_array(m.agent_id,m.note_id), m.agent_id,m.note_id,m.source,
      CASE WHEN m.source = 'owner' THEN 'confirmed' ELSE 'proposed' END,
      json_object('id','legacy-memory:' || json_array(m.agent_id,m.note_id),'subject','Agent memory','text',m.text,
        'labelIds',json(COALESCE((SELECT json_group_array(json_extract(s.value,'$.labelId')) FROM json_each(a.payload_json,'$.scope') s JOIN project_labels l ON l.label_id = json_extract(s.value,'$.labelId') WHERE json_extract(s.value,'$.permissions.read') = 1),'[]')),
        'visibility',CASE WHEN EXISTS(SELECT 1 FROM json_each(a.payload_json,'$.scope') s JOIN project_labels l ON l.label_id = json_extract(s.value,'$.labelId') WHERE json_extract(s.value,'$.permissions.read') = 1) THEN 'labels' ELSE 'user' END,
        'agentId',m.agent_id,'status',CASE WHEN m.source = 'owner' THEN 'confirmed' ELSE 'proposed' END,
        'sourceRefs',json(CASE WHEN m.source LIKE 'thread:%' THEN json_array(json_object('kind','thread','id',substr(m.source,8))) ELSE '[]' END),
        'createdBy',CASE WHEN m.source = 'owner' THEN 'user' ELSE 'agent:' || m.agent_id END,'createdAt',m.created_at,'updatedAt',m.updated_at),m.updated_at
    FROM agent_memory m JOIN agents a ON a.agent_id = m.agent_id`;
  yield* sql`INSERT INTO fact_labels(fact_id,label_id) SELECT f.id,j.value FROM facts f, json_each(f.payload_json,'$.labelIds') j`;
  yield* sql`INSERT INTO fact_history(fact_id,payload_json) SELECT id,json_object('id','migration:' || id,'factId',id,'who',json_extract(payload_json,'$.createdBy'),'at',updated_at,'fact',json(payload_json)) FROM facts`;
  // Facts become the single source of truth; old tool names remain aliases in AgentStore.
  yield* sql`DELETE FROM agent_memory`;
});
