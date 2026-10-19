import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_labels (
    label_id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, description TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  // Thread/repository projections are disposable (repair deletes and replays them).
  // Reference stable IDs without FKs to those projections; domain soft deletes below
  // clean links, while projection rebuilds preserve this independent source of truth.
  yield* sql`CREATE TABLE label_repositories (
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL,
    PRIMARY KEY(label_id, repository_id)
  )`;
  yield* sql`CREATE INDEX label_repositories_repository ON label_repositories(repository_id)`;
  yield* sql`CREATE TABLE thread_project_labels (
    thread_id TEXT NOT NULL,
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    confirmed_by_user INTEGER NOT NULL CHECK(confirmed_by_user IN (0, 1)),
    source TEXT NOT NULL CHECK(source IN ('user', 'suggested')),
    PRIMARY KEY(thread_id, label_id)
  )`;
  yield* sql`CREATE INDEX thread_project_labels_label ON thread_project_labels(label_id)`;
  yield* sql`CREATE TABLE thread_project_label_rejections (
    thread_id TEXT NOT NULL,
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE,
    PRIMARY KEY(thread_id, label_id)
  )`;
  // Same-transaction audit records survive deletion without retaining conversation text.
  yield* sql`CREATE TABLE project_label_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL,
    occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  // Threads/repositories are soft-deleted by their existing projection writers.
  yield* sql`CREATE TRIGGER project_labels_thread_deleted AFTER UPDATE OF deleted_at ON orchestration_v2_projection_threads
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM thread_project_labels WHERE thread_id = NEW.thread_id) OR EXISTS (SELECT 1 FROM thread_project_label_rejections WHERE thread_id = NEW.thread_id)) BEGIN
      INSERT INTO project_label_audit(operation, occurred_at, payload_json)
        VALUES ('thread.deleted', NEW.deleted_at, json_object('threadId', NEW.thread_id));
      DELETE FROM thread_project_labels WHERE thread_id = NEW.thread_id;
      DELETE FROM thread_project_label_rejections WHERE thread_id = NEW.thread_id;
    END`;
  yield* sql`CREATE TRIGGER project_labels_repository_deleted AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (SELECT 1 FROM label_repositories WHERE repository_id = NEW.project_id) BEGIN
      INSERT INTO project_label_audit(operation, occurred_at, payload_json)
        VALUES ('repository.deleted', NEW.deleted_at, json_object('repositoryId', NEW.project_id));
      DELETE FROM label_repositories WHERE repository_id = NEW.project_id;
    END`;
});
