import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Machines paired to this server as their hub, one row per spoke. The
  // spoke's credential is the `peer` auth session named here; unpairing
  // revokes it and deletes the row. report_json is the spoke's last
  // MachineSelfReport, so an offline spoke still lists with its name and kind.
  yield* sql`CREATE TABLE machine_peers (
    environment_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    report_json TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    last_seen_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX machine_peers_session ON machine_peers(session_id)`;
});
