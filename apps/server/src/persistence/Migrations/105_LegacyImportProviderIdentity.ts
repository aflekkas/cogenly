import { OrchestrationV2DomainEventJson } from "@cogenly/contracts";
import { normalizeLegacyProviderThread } from "@cogenly/shared/legacyProviderThreadIdentity";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const tables = {
  threads: "thread.created",
  provider_threads: "provider-thread.updated",
  runs: "run.updated",
  run_attempts: "run-attempt.updated",
  checkpoint_scopes: "checkpoint-scope.updated",
  nodes: "node.updated",
  subagents: "subagent.updated",
  provider_turns: "provider-turn.updated",
  messages: "message.updated",
  turn_items: "turn-item.updated",
  context_handoffs: "context-handoff.updated",
  context_transfers: "context-transfer.updated",
} as const;

// Apply only changed typed leaves, retaining fields written by newer builds.
const changedLeaves = (
  before: unknown,
  after: unknown,
  path = "$",
  changes: Array<readonly [string, unknown]> = [],
) => {
  if (before === after) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    after.forEach((value, index) =>
      changedLeaves(before[index], value, `${path}[${index}]`, changes),
    );
  } else if (
    typeof before === "object" &&
    before !== null &&
    typeof after === "object" &&
    after !== null
  ) {
    const previous = new Map(Object.entries(before));
    for (const [key, value] of Object.entries(after))
      changedLeaves(previous.get(key), value, `${path}.${key}`, changes);
  } else {
    changes.push([path, after]);
  }
  return changes;
};

// Existing local imports must use the same identity as replicated imports.
// Rewrite projections only; the durable log remains the original history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, type] of Object.entries(tables)) {
    const name = `orchestration_v2_projection_${table}`;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(name)})`;
    const threadColumn = table === "context_transfers" ? "target_thread_id" : "thread_id";
    const rows = yield* sql<{ rowid: number; thread_id: string; payload_json: string }>`
      SELECT rowid, ${sql(threadColumn)} AS thread_id, payload_json FROM ${sql(name)}
      WHERE ${sql(threadColumn)} LIKE 'import:%'`;
    for (const row of rows) {
      const event = yield* decodeEvent({
        id: "event:legacy-import-migration",
        type,
        threadId: row.thread_id,
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: yield* decodeJson(row.payload_json),
      });
      const normalized = normalizeLegacyProviderThread(event);
      if (normalized === event) continue;
      for (const [path, value] of changedLeaves(
        encodeEvent(event).payload,
        encodeEvent(normalized).payload,
      )) {
        yield* sql`UPDATE ${sql(name)} SET payload_json = json_set(payload_json, ${path}, json(${encodeJson(value)}))
          WHERE rowid = ${row.rowid}`;
      }
      const imported = /^import:([^:]+):(.+)$/.exec(row.thread_id)!;
      const legacy = `provider-thread:provider:${imported[1]}:native-thread:${imported[2]}`;
      const canonical = `provider-thread:import:${imported[1]}:${imported[2]}`;
      for (const column of columns) {
        if (
          !["provider_thread_id", "active_provider_thread_id", "to_provider_thread_id"].includes(
            column.name,
          )
        )
          continue;
        yield* sql`UPDATE ${sql(name)} SET ${sql(column.name)} = ${canonical}
          WHERE rowid = ${row.rowid} AND ${sql(column.name)} = ${legacy}`;
      }
    }
  }
});
