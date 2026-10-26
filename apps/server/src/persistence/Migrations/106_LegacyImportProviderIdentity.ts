import { OrchestrationV2DomainEventJson } from "@cogenly/contracts";
import { normalizeLegacyProviderThread } from "@cogenly/shared/legacyProviderThreadIdentity";
import * as DateTime from "effect/DateTime";
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
      // Resolve the primary-key collision before changing either the payload or
      // indexed id. Equal timestamps keep the already canonical row.
      if (
        event.type === "provider-thread.updated" &&
        normalized.type === "provider-thread.updated" &&
        event.payload.id !== normalized.payload.id
      ) {
        const existing = yield* sql<{ rowid: number; updated_at: string }>`
          SELECT rowid, updated_at FROM ${sql(name)} WHERE provider_thread_id = ${normalized.payload.id}`;
        if (existing[0] !== undefined) {
          const current = yield* sql<{
            updated_at: string;
          }>`SELECT updated_at FROM ${sql(name)} WHERE rowid = ${row.rowid}`;
          if (existing[0].updated_at >= current[0]!.updated_at) {
            yield* sql`DELETE FROM ${sql(name)} WHERE rowid = ${row.rowid}`;
            continue;
          }
          yield* sql`DELETE FROM ${sql(name)} WHERE rowid = ${existing[0].rowid}`;
        }
      }
      for (const [path, value] of changedLeaves(
        encodeEvent(event).payload,
        encodeEvent(normalized).payload,
      )) {
        yield* sql`UPDATE ${sql(name)} SET payload_json = json_set(payload_json, ${path}, json(${encodeJson(value)}))
          WHERE rowid = ${row.rowid}`;
      }
      const before = encodeEvent(event).payload;
      const after = encodeEvent(normalized).payload;
      const references = [
        ["provider_thread_id", table === "provider_threads" ? "id" : "providerThreadId"],
        ["active_provider_thread_id", "activeProviderThreadId"],
        ["to_provider_thread_id", "toProviderThreadId"],
      ] as const;
      for (const [column, key] of references) {
        if (!columns.some((c) => c.name === column)) continue;
        const previous = Object.entries(before).find(([name]) => name === key)?.[1];
        const next = Object.entries(after).find(([name]) => name === key)?.[1];
        if (typeof previous !== "string" || typeof next !== "string" || previous === next) continue;
        yield* sql`UPDATE ${sql(name)} SET ${sql(column)} = ${next}
          WHERE rowid = ${row.rowid} AND ${sql(column)} = ${previous}`;
      }
    }
  }

  // The original collision could replace an import's row with a native child
  // thread's row. Recover only from that import's own durable history.
  const dangling = yield* sql<{ thread_id: string; active_provider_thread_id: string }>`
    SELECT thread_id, active_provider_thread_id FROM orchestration_v2_projection_threads AS t
    WHERE thread_id LIKE 'import:%' AND active_provider_thread_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads AS p
        WHERE p.provider_thread_id = t.active_provider_thread_id)`;
  for (const thread of dangling) {
    const history = yield* sql<{ event_id: string; occurred_at: string; payload_json: string }>`
      SELECT event_id, occurred_at, payload_json FROM orchestration_events
      WHERE stream_id = ${thread.thread_id} AND event_type = 'provider-thread.updated'
        AND application_event_version = 2
      ORDER BY sequence DESC`;
    let restored = false;
    for (const row of history) {
      const event = normalizeLegacyProviderThread(
        yield* decodeEvent({
          id: row.event_id,
          type: "provider-thread.updated",
          threadId: thread.thread_id,
          occurredAt: row.occurred_at,
          payload: yield* decodeJson(row.payload_json),
        }),
      );
      if (
        event.type !== "provider-thread.updated" ||
        event.payload.id !== thread.active_provider_thread_id ||
        event.payload.appThreadId !== thread.thread_id
      )
        continue;
      const p = event.payload;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
         provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
        VALUES (${p.id}, ${p.appThreadId}, ${p.ownerNodeId}, ${p.providerInstanceId}, ${p.driver},
          ${p.providerInstanceId}, ${p.providerSessionId}, ${p.status}, ${p.firstRunOrdinal},
          ${p.lastRunOrdinal}, ${DateTime.formatIso(p.updatedAt)}, ${encodeJson({
            ...((yield* decodeJson(row.payload_json)) as Record<string, unknown>),
            ...encodeEvent(event).payload,
          })})`;
      restored = true;
      break;
    }
    if (!restored) {
      yield* sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = NULL,
        payload_json = json_set(payload_json, '$.activeProviderThreadId', NULL)
        WHERE thread_id = ${thread.thread_id}`;
    }
  }
});
