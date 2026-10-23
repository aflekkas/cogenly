import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE shared_documents (
    kind TEXT NOT NULL CHECK(kind IN ('project','agent','schedule')), id TEXT NOT NULL,
    fields_json TEXT NOT NULL, clocks_json TEXT NOT NULL, tombstone_json TEXT,
    updated_by_env TEXT NOT NULL, PRIMARY KEY(kind,id)
  )`;
  yield* sql`CREATE TABLE shared_changes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT, change_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE shared_peer_cursors (
    environment_id TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0,
    acknowledged INTEGER NOT NULL DEFAULT 0
  )`;
  // Checkout locations remain local even when a remote moves between shared projects.
  yield* sql`CREATE TABLE shared_repository_checkouts (
    remote TEXT PRIMARY KEY, repository_id TEXT NOT NULL, directory_name TEXT
  )`;
  yield* sql`CREATE TABLE shared_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), clock_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE shared_possible_duplicates (
    kind TEXT NOT NULL, first_id TEXT NOT NULL, second_id TEXT NOT NULL,
    PRIMARY KEY(kind,first_id,second_id)
  )`;
  // Removing a clone does not remove the shared repository identity from its project.
  yield* sql`DROP TRIGGER project_labels_repository_deleted`;
  yield* sql`CREATE TRIGGER project_labels_repository_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
      INSERT INTO project_label_audit(operation,occurred_at,payload_json) VALUES ('repository.deleted',NEW.deleted_at,json_object('repositoryId',NEW.project_id));
      DELETE FROM shared_repository_checkouts WHERE repository_id=NEW.project_id;
      UPDATE OR IGNORE label_repositories SET repository_id='remote:' || remote WHERE repository_id=NEW.project_id AND remote IS NOT NULL;
      DELETE FROM label_repositories WHERE repository_id=NEW.project_id;
    END`;
  // Filled with the stable environment identity before any scheduler starts.
  // SQL migrations intentionally do not read machine identity files.
  yield* sql`ALTER TABLE agents ADD COLUMN owner_machine TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_machine TEXT`;
});
