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

describe("091_RestoreNonImportT3ScratchProjects", () => {
  it.effect("restores empty scratch projects 084 deleted that the T3 import did not create", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      const projects = [
        ["imported-empty", "/Users/me/.t3/scratch/from-import"],
        ["hand-added-empty", "/Users/me/.t3/scratch/by-hand"],
        ["repository", "/Users/me/code/site"],
      ] as const;
      for (const [id, root] of projects) {
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${id}, ${id}, ${root}, '[]', ${at}, ${at})`;
      }
      yield* sql`INSERT INTO t3_import_projects (source_project_id, project_id, workspace_root, action, imported_at)
        VALUES ('t3-project', 'imported-empty', '/Users/me/.t3/scratch/from-import', 'created', ${at})`;

      // 084 soft-deletes both empty scratch projects.
      yield* runMigrations({ toMigrationInclusive: 84 });
      const after084 = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id
      `;
      expect(after084.map((row) => row.project_id)).toEqual(["repository"]);

      yield* runMigrations();

      const live = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id
      `;
      expect(live.map((row) => row.project_id)).toEqual(["hand-added-empty", "repository"]);
    }).pipe(Effect.provide(layer)),
  );
});
