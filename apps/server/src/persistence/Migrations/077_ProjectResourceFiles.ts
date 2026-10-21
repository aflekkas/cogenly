import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Derived index of project-label resource files, rebuilt from disk by the
// project-files service. The folder is the source of truth; these rows only
// make listing and recall fast.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_resource_files (
    label_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL,
    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT,
    modified_at TEXT NOT NULL, content_text TEXT,
    PRIMARY KEY (label_id, relative_path)
  )`;
  yield* sql`CREATE INDEX project_resource_files_label ON project_resource_files(label_id)`;
  yield* sql`CREATE TABLE project_resource_index_state (
    label_id TEXT PRIMARY KEY, truncated INTEGER NOT NULL, scanned_at TEXT NOT NULL
  )`;
  const fts =
    yield* sql`CREATE VIRTUAL TABLE project_resource_fts USING fts5(relative_path, content_text, content='project_resource_files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`.pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  yield* sql`CREATE TABLE project_resource_search_config (engine TEXT NOT NULL)`;
  yield* sql`INSERT INTO project_resource_search_config VALUES (${fts ? "fts5" : "like"})`;
  if (fts) {
    yield* sql`CREATE TRIGGER project_resource_files_insert AFTER INSERT ON project_resource_files BEGIN
      INSERT INTO project_resource_fts(rowid, relative_path, content_text) VALUES (NEW.rowid, NEW.relative_path, NEW.content_text); END`;
    yield* sql`CREATE TRIGGER project_resource_files_delete AFTER DELETE ON project_resource_files BEGIN
      INSERT INTO project_resource_fts(project_resource_fts, rowid, relative_path, content_text) VALUES ('delete', OLD.rowid, OLD.relative_path, OLD.content_text); END`;
    yield* sql`CREATE TRIGGER project_resource_files_update AFTER UPDATE ON project_resource_files BEGIN
      INSERT INTO project_resource_fts(project_resource_fts, rowid, relative_path, content_text) VALUES ('delete', OLD.rowid, OLD.relative_path, OLD.content_text);
      INSERT INTO project_resource_fts(rowid, relative_path, content_text) VALUES (NEW.rowid, NEW.relative_path, NEW.content_text); END`;
  } else {
    yield* Effect.logWarning("SQLite FTS5 unavailable; project recall uses substring LIKE.");
  }
});
