import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";

const layer = NodeSqlite.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer));
const at = "2026-01-01T00:00:00.000Z";
it.effect(
  "retains one deterministic legacy membership and preserves every folder, repo and thread",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      for (const id of ["old", "new", "tie"])
        yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${id}, ${id}, ${id === "new" ? "2026-02-01T00:00:00.000Z" : at}, ${at})`;
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('repo', 'Repo', '/repo', '[]', ${at}, ${at})`;
      for (const thread of ["confirmed", "confidence", "oldest", "stable-id"])
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${thread}, 'repo', ${thread}, 'codex', 'full-access', 'default', ${at}, ${at}, '{}')`;
      yield* sql`INSERT INTO thread_project_labels VALUES ('confirmed','old',0.99,0,'suggested'), ('confirmed','new',0.1,1,'user'), ('confidence','old',0.2,0,'suggested'), ('confidence','new',0.9,0,'suggested'), ('oldest','new',0.5,1,'user'), ('oldest','old',0.5,1,'user'), ('stable-id','tie',NULL,0,'user'), ('stable-id','old',NULL,0,'user')`;
      yield* sql`INSERT INTO label_repositories VALUES ('new','repo'),('tie','repo'),('old','repo')`;
      yield* sql`INSERT INTO thread_project_label_rejections VALUES ('oldest','tie')`;
      expect(yield* runMigrations({ toMigrationInclusive: 74 })).toEqual([[74, "ProjectFolders"]]);
      expect(yield* sql`SELECT * FROM thread_project_labels ORDER BY thread_id`).toEqual([
        { thread_id: "confidence", label_id: "new" },
        { thread_id: "confirmed", label_id: "new" },
        { thread_id: "oldest", label_id: "old" },
        { thread_id: "stable-id", label_id: "old" },
      ]);
      expect(yield* sql`SELECT * FROM label_repositories`).toEqual([
        { label_id: "old", repository_id: "repo" },
      ]);
      expect((yield* sql`SELECT count(*) AS n FROM project_labels`)[0]?.n).toBe(3);
      expect((yield* sql`SELECT count(*) AS n FROM projection_projects`)[0]?.n).toBe(1);
      expect(
        (yield* sql`SELECT count(*) AS n FROM orchestration_v2_projection_threads`)[0]?.n,
      ).toBe(4);
      expect(
        yield* sql`INSERT INTO thread_project_labels VALUES ('confirmed','old')`.pipe(Effect.flip),
      ).toBeDefined();
      expect(
        yield* sql`INSERT INTO label_repositories VALUES ('new','repo')`.pipe(Effect.flip),
      ).toBeDefined();
      expect(yield* runMigrations({ toMigrationInclusive: 74 })).toEqual([]);
    }).pipe(Effect.provide(layer)),
);
