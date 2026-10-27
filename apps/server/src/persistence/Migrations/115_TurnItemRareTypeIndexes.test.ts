import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "@cogenly/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqlite.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer));

// The WHERE shapes of ProjectionStore's runtime recovery arm and shell pending
// read. Both must stay on their partial indexes: a generic type index reads
// every tool-call row, seconds per query on a large database.
it.effect("runtime recovery and shell pending reads use their partial indexes", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const plan = (rows: ReadonlyArray<{ readonly detail: string }>) =>
      rows.map((row) => row.detail).join("\n");

    const recovery = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
      WHERE NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
        )
        AND type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND status IN ('pending', 'running', 'waiting')
    `;
    expect(plan(recovery)).toContain("orchestration_v2_projection_turn_items_recovery_idx");

    const shellPending = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT i.thread_id, i.payload_json
      FROM orchestration_v2_projection_turn_items i
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
        AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
    `;
    expect(plan(shellPending)).toContain(
      "orchestration_v2_projection_turn_items_shell_pending_idx",
    );

    const stopRequest = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_turn_items request
      WHERE request.thread_id = 't' AND request.run_id = 'r' AND request.type = 'run_interrupt_request'
    `;
    expect(plan(stopRequest)).toContain("orchestration_v2_projection_turn_items_stop_request_idx");
    const counts = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT thread_id, run_id, count(*) FROM orchestration_v2_projection_turn_items
      WHERE thread_id IN ('one', 'two') GROUP BY thread_id, run_id
    `;
    expect(plan(counts)).toContain(
      "COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx",
    );
    expect(plan(counts)).not.toContain("SCAN orchestration_v2_projection_turn_items");

    const errors = yield* sql<{ detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM orchestration_v2_projection_turn_items
      WHERE type = 'error' AND updated_at >= ${"2026-01-01T00:00:00.000Z"}
    `;
    expect(plan(errors)).toContain("orchestration_v2_projection_turn_items_error_updated_idx");
  }).pipe(Effect.provide(layer)),
);
