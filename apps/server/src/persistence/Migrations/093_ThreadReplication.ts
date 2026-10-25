import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A thread without a row is owned here. Replicas record their owner; a
  // pending handoff fences local writes until the target accepts or refuses.
  yield* sql`CREATE TABLE thread_owners (
    thread_id TEXT PRIMARY KEY,
    owner_env TEXT NOT NULL,
    local INTEGER NOT NULL CHECK(local IN (0,1)),
    epoch INTEGER NOT NULL DEFAULT 0,
    handoff_json TEXT,
    source_json TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE thread_replication_cursors (
    environment_id TEXT PRIMARY KEY,
    received_events INTEGER NOT NULL DEFAULT 0,
    received_meta INTEGER NOT NULL DEFAULT 0,
    acknowledged_events INTEGER NOT NULL DEFAULT 0,
    acknowledged_meta INTEGER NOT NULL DEFAULT 0
  )`;
  // Thread metadata that is not an orchestration event (filing, ownership)
  // replicates by thread id; senders read the current value at send time.
  yield* sql`CREATE TABLE thread_replication_meta_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TRIGGER thread_replication_filed AFTER INSERT ON thread_project_labels BEGIN
    INSERT INTO thread_replication_meta_log(thread_id) VALUES (NEW.thread_id);
  END`;
  yield* sql`CREATE TRIGGER thread_replication_unfiled AFTER DELETE ON thread_project_labels BEGIN
    INSERT INTO thread_replication_meta_log(thread_id) VALUES (OLD.thread_id);
  END`;
  yield* sql`CREATE TRIGGER thread_replication_owner_created AFTER INSERT ON thread_owners BEGIN
    INSERT INTO thread_replication_meta_log(thread_id) VALUES (NEW.thread_id);
  END`;
  yield* sql`CREATE TRIGGER thread_replication_owner_changed AFTER UPDATE OF owner_env, epoch ON thread_owners
    WHEN NEW.owner_env IS NOT OLD.owner_env OR NEW.epoch IS NOT OLD.epoch BEGIN
    INSERT INTO thread_replication_meta_log(thread_id) VALUES (NEW.thread_id);
  END`;
});
