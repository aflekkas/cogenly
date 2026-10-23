import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Imports from T3 Code used to turn its no-project folder (~/.t3/scratch)
  // and its per-chat folders under it into repository records. The import now
  // files those threads under "No project"; this removes the records left
  // behind that own no threads. Records that still own threads are kept:
  // moving threads is a command, not something a migration rewrites. Removal
  // matches a project delete (deleted_at), so its label links and search
  // entries are cleaned up by their triggers.
  yield* sql`
    UPDATE projection_projects
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL
      AND (
        workspace_root LIKE '%/.t3/scratch'
        OR workspace_root LIKE '%/.t3/scratch/%'
        OR workspace_root LIKE '%\\.t3\\scratch'
        OR workspace_root LIKE '%\\.t3\\scratch\\%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.project_id = projection_projects.project_id
      )
  `;
});
