// @effect-diagnostics nodeBuiltinImport:off - seeds an older database before opening the persistence layer.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";

import * as Sqlite from "./Sqlite.ts";

it.live("opening an older database clears stale statistics on writer and reader connections", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-sqlite-stats-" });
    const filename = directory + "/state.sqlite";
    const old = new NodeSqlite.DatabaseSync(filename);
    try {
      old.exec(
        "CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT); INSERT INTO walk_probe VALUES ('node-1',NULL),('node-2','node-1'); ANALYZE walk_probe",
      );
      expect(
        old.prepare("SELECT count(*) AS count FROM sqlite_stat1").get()?.count,
      ).toBeGreaterThan(0);
    } finally {
      old.close();
    }
    const context = yield* Layer.build(Sqlite.layerFromPath(filename));
    const sql = Context.get(context, SqlClient.SqlClient);
    const read = Effect.gen(function* () {
      const stats = yield* sql.unsafe<{ count: number }>(
        "SELECT count(*) AS count FROM sqlite_stat1",
      );
      expect(stats[0]?.count).toBe(0);
      const plan = yield* sql.unsafe<{ detail: string }>(
        "EXPLAIN QUERY PLAN WITH RECURSIVE retained(node_id) AS (SELECT 'node-2' UNION SELECT parent.parent_node_id FROM walk_probe AS parent INNER JOIN retained ON parent.node_id=retained.node_id) SELECT node_id FROM retained",
      );
      expect(plan.map((row) => row.detail)).toContain(
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
      const roots = yield* sql.unsafe<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT payload_json FROM orchestration_v2_projection_nodes INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1 WHERE thread_id='thread:test' AND node_id IN ('node:test') ORDER BY node_id ASC",
      );
      expect(
        roots.some((row) =>
          row.detail.includes(
            "SEARCH orchestration_v2_projection_nodes USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1",
          ),
        ),
      ).toBe(true);
      const revision = yield* sql.unsafe<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT COALESCE(MAX(sequence),0) FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id IN ('thread:test')",
      );
      expect(
        revision.some((row) =>
          row.detail.includes(
            "SEARCH orchestration_events USING INDEX idx_orch_events_stream_sequence",
          ),
        ),
      ).toBe(true);
    });
    yield* read;
    yield* read.pipe(NodeSqliteClient.readOnly);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a fresh database opens without collecting planner statistics", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql.unsafe("SELECT name FROM sqlite_schema WHERE name='sqlite_stat1'")).toEqual(
      [],
    );
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);
