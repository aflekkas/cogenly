import { ProjectLabelId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Filing is metadata, not an owner-authored thread event. Resolve old metadata after a merge too. */
export const resolveProjectLabelId = Effect.fn("ProjectMerge.resolveProjectLabelId")(function* (
  id: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const seen = new Set<string>();
  while (id !== null) {
    if (seen.has(id)) return null;
    seen.add(id);
    const rows = yield* sql<{
      deleted: string | null;
      target: string | null;
    }>`SELECT tombstone_json AS deleted,json_extract(fields_json,'$.mergedInto') AS target FROM shared_documents WHERE kind='project' AND id=${id}`;
    const row = rows[0];
    if (!row?.deleted) return ProjectLabelId.make(id);
    id = row.target;
  }
  return null;
});

/** Applies only local read models; never claims authorship of a peer's documents or thread log. */
export const projectPendingMerges = Effect.fn("ProjectMerge.projectPendingMerges")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const merges = yield* sql<{
    id: string;
    target: string;
  }>`SELECT id,json_extract(fields_json,'$.mergedInto') AS target FROM shared_documents WHERE kind='project' AND tombstone_json IS NOT NULL AND json_type(fields_json,'$.mergedInto')='text'`;
  for (const merge of merges) {
    if ((yield* sql`SELECT 1 FROM project_labels WHERE label_id=${merge.id}`).length === 0)
      continue;
    const target = yield* resolveProjectLabelId(merge.target);
    if (target === null || target === merge.id) continue;
    if ((yield* sql`SELECT 1 FROM project_labels WHERE label_id=${target}`).length === 0) continue;
    // Insert/delete, rather than UPDATE, fires the normal filing replication triggers.
    yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) SELECT project_chat_thread_id,${target} FROM project_labels WHERE label_id=${merge.id} AND project_chat_thread_id IS NOT NULL ON CONFLICT(thread_id) DO NOTHING`;
    const threads = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM thread_project_labels WHERE label_id=${merge.id}`;
    yield* sql`DELETE FROM thread_project_labels WHERE label_id=${merge.id}`;
    for (const thread of threads)
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${thread.thread_id},${target})`;
    yield* sql`UPDATE project_labels SET project_chat_thread_id=COALESCE(project_chat_thread_id,(SELECT project_chat_thread_id FROM project_labels WHERE label_id=${merge.id})) WHERE label_id=${target}`;
    yield* sql`UPDATE label_repositories SET label_id=${target} WHERE label_id=${merge.id}`;
    yield* sql`INSERT OR IGNORE INTO label_source_links(label_id,kind,owner,repo,created_at) SELECT ${target},kind,owner,repo,created_at FROM label_source_links WHERE label_id=${merge.id}`;
    yield* sql`UPDATE agents SET payload_json=json_set(payload_json,'$.projectFolderId',${target}) WHERE json_extract(payload_json,'$.projectFolderId')=${merge.id}`;
    yield* sql`UPDATE scheduled_tasks SET project_folder_id=${target} WHERE project_folder_id=${merge.id}`;
    yield* sql`UPDATE facts SET payload_json=json_set(payload_json,'$.labelIds',json((SELECT json_group_array(value) FROM (SELECT DISTINCT CASE WHEN value=${merge.id} THEN ${target} ELSE value END AS value FROM json_each(facts.payload_json,'$.labelIds'))))) WHERE EXISTS (SELECT 1 FROM json_each(facts.payload_json,'$.labelIds') WHERE value=${merge.id})`;
    yield* sql`INSERT OR IGNORE INTO fact_labels(fact_id,label_id) SELECT fact_id,${target} FROM fact_labels WHERE label_id=${merge.id}`;
    yield* sql`UPDATE commitments SET payload_json=json_set(payload_json,'$.labelIds',json((SELECT json_group_array(value) FROM (SELECT DISTINCT CASE WHEN value=${merge.id} THEN ${target} ELSE value END AS value FROM json_each(commitments.payload_json,'$.labelIds'))))) WHERE EXISTS (SELECT 1 FROM json_each(commitments.payload_json,'$.labelIds') WHERE value=${merge.id})`;
    yield* sql`INSERT OR IGNORE INTO commitment_labels(commitment_id,label_id) SELECT commitment_id,${target} FROM commitment_labels WHERE label_id=${merge.id}`;
    yield* sql`DELETE FROM project_resource_files WHERE label_id IN (${merge.id},${target})`;
    yield* sql`DELETE FROM project_resource_index_state WHERE label_id IN (${merge.id},${target})`;
    yield* sql`DELETE FROM project_labels WHERE label_id=${merge.id}`;
  }
});
