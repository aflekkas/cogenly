import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // 084 matched projects by folder path alone, so an empty project the
  // user had added by hand at (or under) T3 Code's scratch folder was
  // soft-deleted along with the T3-import leftovers. Restore those: a
  // project the T3 import created is in its ledger (t3_import_projects)
  // and stays removed. Only empty projects are restored, matching what
  // 084 could delete; label links cleaned up on delete are not recreated.
  yield* sql`
    UPDATE projection_projects
    SET deleted_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NOT NULL
      AND (
        workspace_root LIKE '%/.t3/scratch'
        OR workspace_root LIKE '%/.t3/scratch/%'
        OR workspace_root LIKE '%\\.t3\\scratch'
        OR workspace_root LIKE '%\\.t3\\scratch\\%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM t3_import_projects AS imported
        WHERE imported.project_id = projection_projects.project_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS thread
        WHERE thread.project_id = projection_projects.project_id
      )
  `;
});
