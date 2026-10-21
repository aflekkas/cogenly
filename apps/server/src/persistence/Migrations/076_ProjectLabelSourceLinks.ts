import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Code sources a project links to: whole GitHub owners, or single
  // repositories. Owner links store an empty repo so the key stays a plain
  // primary key; the service maps rows back to the link union.
  yield* sql`CREATE TABLE label_source_links (
    label_id TEXT NOT NULL REFERENCES project_labels(label_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('github-owner', 'github-repo')),
    owner TEXT NOT NULL,
    repo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY(label_id, kind, owner, repo),
    CHECK((kind = 'github-owner' AND repo = '') OR (kind = 'github-repo' AND repo <> ''))
  )`;
  yield* sql`CREATE INDEX label_source_links_owner ON label_source_links(owner, repo)`;
});
