import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Local execution consent never travels with a repository or to another machine.
  yield* sql`CREATE TABLE repo_mcp_trust (id TEXT PRIMARY KEY, remote TEXT NOT NULL, definition_hash TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('pending','trusted','denied')), UNIQUE(remote,definition_hash))`;
  yield* sql`CREATE TABLE repo_mcp_trust_prompts (trust_id TEXT NOT NULL REFERENCES repo_mcp_trust(id), thread_id TEXT NOT NULL, servers_json TEXT NOT NULL, PRIMARY KEY(trust_id,thread_id))`;
});
