import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const columns = "key, kind, id, thread_id, title, body, matched_at";
const select = `SELECT 'fact:' || id, 'fact', id, NULL,
  coalesce(json_extract(payload_json, '$.subject'), ''),
  coalesce(json_extract(payload_json, '$.text'), ''), updated_at
  FROM facts WHERE status = 'confirmed'`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [name, event] of [
    ["insert", "INSERT"],
    ["update", "UPDATE OF id, status, payload_json, updated_at"],
    ["delete", "DELETE"],
  ] as const) {
    yield* sql.unsafe(`CREATE TRIGGER search_facts_${name} AFTER ${event} ON facts BEGIN
      DELETE FROM search_documents WHERE key = 'fact:' || ${name === "insert" ? "NEW" : "OLD"}.id;
      ${name === "delete" ? "" : `INSERT INTO search_documents(${columns}) ${select} AND id = NEW.id;`} END`);
  }
  // Keep the backfill bounded even for environments with years of memory.
  let after = "";
  while (true) {
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM facts WHERE id > ${after} ORDER BY id LIMIT 250`;
    const last = rows.at(-1)?.id;
    if (last === undefined) break;
    yield* sql.unsafe(`INSERT INTO search_documents(${columns}) ${select} AND id > ? AND id <= ?`, [
      after,
      last,
    ]);
    after = last;
  }
});
