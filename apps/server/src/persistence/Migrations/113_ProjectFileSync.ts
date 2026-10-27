import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What this machine's project folder held for each path when it last agreed
// with the shared `project-file` document: a disk change against it is a local
// edit to publish. Local only; ProjectFileSync owns it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_file_sync_state (
    label_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    sha256 TEXT,
    PRIMARY KEY (label_id, relative_path)
  )`;
});
