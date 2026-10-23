import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// A bare client: the app's memory layer would already have run every migration.
const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provide(NodeServices.layer),
);
const at = "2026-01-01T00:00:00.000Z";

describe("084_RemoveEmptyT3ScratchProjects", () => {
  it.effect("deletes empty projects at or under T3 Code's scratch folder only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      const projects = [
        ["scratch-empty", "/Users/me/.t3/scratch"],
        ["scratch-chat-empty", "/Users/me/.t3/scratch/2026-10-03-yo"],
        ["scratch-with-thread", "/Users/me/.t3/scratch/2026-10-04-hi"],
        ["windows-scratch", "C:\\Users\\me\\.t3\\scratch\\2026-10-05-x"],
        ["repository", "/Users/me/code/site"],
        ["lookalike", "/Users/me/.t3/scratchpad"],
      ] as const;
      for (const [id, root] of projects) {
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${id}, ${id}, ${root}, '[]', ${at}, ${at})`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('thread', 'scratch-with-thread', 'Chat', 'codex', 'full-access', 'default', ${at}, ${at}, '{}')`;

      yield* runMigrations();

      const live = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id
      `;
      expect(live.map((row) => row.project_id)).toEqual([
        "lookalike",
        "repository",
        "scratch-with-thread",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
