import { ThreadId, ThreadReplicaMeta } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveProjectLabelId } from "../sync/ProjectMergeProjection.ts";

const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadReplicaMeta));

/** The retained owner metadata is also the durable filing intent when its project is missing. */
export const projectReplicaFilings = Effect.fn("ThreadReplication.projectFilings")(function* (
  threadId?: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  let after = "";
  for (;;) {
    const rows = yield* sql<{ readonly thread_id: string; readonly meta_extra_json: string }>`
      SELECT o.thread_id, o.meta_extra_json FROM thread_owners o
      JOIN orchestration_v2_projection_threads t ON t.thread_id = o.thread_id
      WHERE o.local = 0 AND o.meta_extra_json IS NOT NULL AND o.thread_id > ${after}
        ${threadId === undefined ? sql`` : sql`AND o.thread_id = ${threadId}`}
      ORDER BY o.thread_id LIMIT 128`;
    for (const row of rows) {
      const meta = decodeMeta(row.meta_extra_json);
      if (Option.isNone(meta)) continue;
      const folderId = yield* resolveProjectLabelId(meta.value.folderId);
      const filed = yield* sql<{
        readonly label_id: string;
      }>`SELECT label_id FROM thread_project_labels WHERE thread_id = ${row.thread_id}`;
      if ((filed[0]?.label_id ?? null) === folderId) continue;
      yield* sql`DELETE FROM thread_project_labels WHERE thread_id = ${row.thread_id}`;
      if (folderId !== null)
        yield* sql`INSERT INTO thread_project_labels(thread_id, label_id)
          SELECT ${row.thread_id}, label_id FROM project_labels WHERE label_id = ${folderId}`;
    }
    if (rows.length < 128) return;
    after = rows.at(-1)!.thread_id;
  }
});
