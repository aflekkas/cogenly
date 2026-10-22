import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Project instructions, injected into every thread filed in the project;
  // existing projects start with none.
  yield* sql`ALTER TABLE project_labels ADD COLUMN instructions TEXT NOT NULL DEFAULT ''`;
  // The project's own chat, created lazily on first visit. A plain pointer,
  // not a foreign key: a deleted thread is replaced on the next visit.
  yield* sql`ALTER TABLE project_labels ADD COLUMN project_chat_thread_id TEXT`;
});
