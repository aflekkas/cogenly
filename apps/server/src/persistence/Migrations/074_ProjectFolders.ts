import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Preserve the user's strongest choice. Legacy links have no timestamp, so
  // folder creation time supplies the oldest tie-break, followed by stable id.
  yield* sql`DELETE FROM thread_project_labels WHERE rowid IN (
    SELECT membership_rowid FROM (
      SELECT t.rowid AS membership_rowid, row_number() OVER (
        PARTITION BY t.thread_id ORDER BY t.confirmed_by_user DESC,
          t.confidence DESC, l.created_at, l.label_id
      ) AS rank FROM thread_project_labels t JOIN project_labels l USING(label_id)
    ) WHERE rank > 1
  )`;
  yield* sql`DELETE FROM label_repositories WHERE rowid IN (
    SELECT membership_rowid FROM (
      SELECT r.rowid AS membership_rowid, row_number() OVER (
        PARTITION BY r.repository_id ORDER BY l.created_at, l.label_id
      ) AS rank FROM label_repositories r JOIN project_labels l USING(label_id)
    ) WHERE rank > 1
  )`;
  yield* sql`CREATE UNIQUE INDEX label_repositories_single_folder ON label_repositories(repository_id)`;
  yield* sql`DROP TRIGGER project_labels_thread_deleted`;
  yield* sql`CREATE TABLE thread_project_folders (
    thread_id TEXT PRIMARY KEY,
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE
  )`;
  yield* sql`INSERT INTO thread_project_folders(thread_id, label_id)
    SELECT thread_id, label_id FROM thread_project_labels`;
  yield* sql`DROP TABLE thread_project_labels`;
  yield* sql`ALTER TABLE thread_project_folders RENAME TO thread_project_labels`;
  yield* sql`CREATE INDEX thread_project_labels_label ON thread_project_labels(label_id)`;
  yield* sql`DROP TABLE thread_project_label_rejections`;
  yield* sql`CREATE TRIGGER project_labels_thread_deleted AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM thread_project_labels WHERE thread_id = NEW.thread_id) BEGIN
      INSERT INTO project_label_audit(operation, occurred_at, payload_json)
        VALUES ('thread.deleted', NEW.deleted_at, json_object('threadId', NEW.thread_id));
      DELETE FROM thread_project_labels WHERE thread_id = NEW.thread_id;
    END`;
  // Independent membership survives projection repair. The view derives repo
  // membership at read time, so moving a repo also moves all unfiled work.
  yield* sql`CREATE VIEW effective_thread_project_folders AS
    SELECT t.thread_id, COALESCE(explicit.label_id, repository.label_id) AS folder_id
    FROM orchestration_v2_projection_threads t
    LEFT JOIN thread_project_labels explicit ON explicit.thread_id = t.thread_id
    LEFT JOIN label_repositories repository ON repository.repository_id = t.project_id
      AND COALESCE(json_extract(t.payload_json, '$.surface'), 'work') = 'work'
    WHERE t.deleted_at IS NULL`;
});
