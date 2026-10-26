import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";

import { runMigrations } from "../src/persistence/Migrations.ts";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

it.effect("seeds the current schema without foreign-key orphans or live work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-" });
    const source = path.join(directory, "source.sqlite");
    yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
    const fixture = new NodeSqlite.DatabaseSync(source);
    try {
      const at = "2026-01-01T00:00:00.000Z";
      for (const project of ["keep", "old"]) {
        fixture
          .prepare(`INSERT INTO projection_projects
          (project_id,title,workspace_root,scripts_json,created_at,updated_at)
          VALUES (?,?,?,'[]',?,?)`)
          .run(project, project, directory, at, at);
      }
      for (const [id, project, payload] of [
        ["keep", "keep", {}],
        ["older", "keep", {}],
        ["hidden", "keep", { settledAt: at }],
        ["working", "old", {}],
      ] as const) {
        fixture
          .prepare(`INSERT INTO orchestration_v2_projection_threads
          (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
          VALUES (?,?,?,'codex','full-access','default',?,?,?)`)
          .run(
            id,
            project,
            id,
            at,
            id === "keep" ? "2026-02-01T00:00:00.000Z" : at,
            JSON.stringify(payload),
          );
        fixture
          .prepare(`INSERT INTO orchestration_events
          (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
          VALUES (?,'thread',?,1,'thread.created',?,'user','{}','{}')`)
          .run(id, id, at);
        fixture.prepare(`INSERT INTO thread_replication_raw_events VALUES (?, '{}')`).run(id);
        fixture.prepare(`INSERT INTO thread_handoff_repositories VALUES (?,1,'{}',NULL)`).run(id);
      }
      fixture
        .prepare(`INSERT INTO orchestration_v2_projection_runs
        (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
        VALUES ('run','working',1,'codex','running',?,'{}')`)
        .run(at);
      fixture
        .prepare(`INSERT INTO scheduled_tasks
        (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,
         runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
        VALUES ('task','Task','Run',1,'{}','keep','{}','{}','full-access','default','user','web',?,?,'never',0)`)
        .run(at, at);
      fixture
        .prepare(`INSERT INTO auth_sessions
        (session_id,subject,scopes,method,issued_at,expires_at)
        VALUES ('session','owner','[]','token',?,?)`)
        .run(at, at);
      fixture.exec(`INSERT INTO thread_replication_deferred
        (thread_id,item_kind,source_env,trusted_relay,item_json) VALUES ('keep','event','remote',1,'{}');
        INSERT INTO shared_deferred_changes(source_env,trusted_relay,change_json) VALUES ('remote',1,'{}');
        -- Future dependencies: reverse table order, composite implicit parent key,
        -- nullable FK, and a dependent table without rowids.
        CREATE TABLE future_leaf (a TEXT, b TEXT, PRIMARY KEY(a,b),
          FOREIGN KEY(a,b) REFERENCES future_parent) WITHOUT ROWID;
        CREATE TABLE future_parent (a TEXT, b TEXT, event_id TEXT REFERENCES orchestration_events(event_id), PRIMARY KEY(a,b));
        INSERT INTO future_parent VALUES ('hidden','key','hidden'),('old','key','older'),('keep','key','keep'),('null','key',NULL);
        INSERT INTO future_leaf VALUES ('hidden','key'),('old','key'),('keep','key'),('null','key');`);
      expect(fixture.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      fixture.close();
    }
    const sourceBefore = yield* fs.readFile(source);
    const result = yield* runMigrateDevDb({
      source,
      baseDir: path.join(directory, "dev"),
      projects: 1,
      threadsPerProject: 1,
    });
    expect(yield* fs.readFile(source)).toEqual(sourceBefore);
    const seeded = new NodeSqlite.DatabaseSync(result.databasePath, { readOnly: true });
    try {
      expect(seeded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        seeded.prepare("SELECT thread_id FROM orchestration_v2_projection_threads").all(),
      ).toEqual([{ thread_id: "keep" }]);
      expect(seeded.prepare("SELECT event_id FROM thread_replication_raw_events").all()).toEqual([
        { event_id: "keep" },
      ]);
      expect(seeded.prepare("SELECT a FROM future_leaf ORDER BY a").all()).toEqual([
        { a: "keep" },
        { a: "null" },
      ]);
      expect(seeded.prepare("SELECT thread_id FROM thread_handoff_repositories").all()).toEqual([
        { thread_id: "keep" },
      ]);
      for (const table of [
        "scheduled_tasks",
        "auth_sessions",
        "thread_replication_deferred",
        "shared_deferred_changes",
      ])
        expect(seeded.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    } finally {
      seeded.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
