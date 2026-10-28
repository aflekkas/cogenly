import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./113_InlineRequestLookupIndexes.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer));

it.effect("background card and health lookups exclude large tool history from their query plans", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, event_type TEXT, payload_json TEXT)`;
    yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO orchestration_events SELECT x, 'turn-item.updated', json_object('output', hex(zeroblob(4096))) FROM n`;
    yield* sql`INSERT INTO orchestration_events VALUES (2001, 'subagent.updated', '{"childThreadId":"child","origin":"app_owned"}')`;
    yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, run_id TEXT, type TEXT, updated_at TEXT, payload_json TEXT)`;
    yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO orchestration_v2_projection_turn_items SELECT 'busy-thread', 'run', 'command_execution', '2026-10-26T00:00:00.000Z', json_object('output', hex(zeroblob(4096))) FROM n`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items VALUES
      ('setup', 'run', 'secret_request', '2026-10-26T00:00:00.000Z', '{"secretStatus":"pending","integrationSetup":{}}'),
      ('skipped', 'run', 'secret_request', '2026-10-26T00:00:00.000Z', '{"secretStatus":"skipped","integrationSetup":{}}'),
      ('done', 'run', 'secret_request', '2026-10-26T00:00:00.000Z', '{"secretStatus":"saved","integrationSetup":{}}'),
      ('limited', 'run', 'error', '2026-10-26T00:00:00.000Z', '{"failure":{"limitKind":"rate_limit"}}')`;
    yield* migration;
    const childPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_events WHERE event_type = 'subagent.updated' AND json_extract(payload_json, '$.childThreadId') = 'missing-child' AND json_extract(payload_json, '$.origin') = 'app_owned' LIMIT 1`;
    expect(childPlan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("delegated_child_idx"))).toBe(true);
    const cards = sql`SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type = 'secret_request' AND json_extract(payload_json, '$.secretStatus') IN ('pending', 'skipped') AND json_type(payload_json, '$.integrationSetup') = 'object'`;
    expect(yield* cards).toEqual([{ thread_id: "setup" }, { thread_id: "skipped" }]);
    const cardPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT DISTINCT thread_id FROM orchestration_v2_projection_turn_items WHERE type = 'secret_request' AND json_extract(payload_json, '$.secretStatus') IN ('pending', 'skipped') AND json_type(payload_json, '$.integrationSetup') = 'object'`;
    expect(cardPlan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("secret_status_idx"))).toBe(true);
    const healthPlan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT thread_id, run_id FROM orchestration_v2_projection_turn_items WHERE type = 'error' AND updated_at >= '2026-10-25' AND (json_extract(payload_json, '$.failure.limitKind') = 'rate_limit' OR json_extract(payload_json, '$.failure.code') = 'rateLimitExceeded')`;
    expect(healthPlan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("rate_limit_idx"))).toBe(true);
  }).pipe(Effect.provide(layer)),
);
