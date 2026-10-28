import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE health_auto_fix_attempts (
    item_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  )`;
});
