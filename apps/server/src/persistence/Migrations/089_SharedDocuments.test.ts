import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provide(NodeServices.layer),
);

describe("089_SharedDocuments", () => {
  it.effect("upgrades an accounts database without losing accounts or process approvals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect(migrationManifest.filter(([id]) => id >= 85 && id <= 89)).toEqual([
        [85, "AgentProviderFallback"],
        [86, "MachinePeers"],
        [87, "Accounts"],
        [88, "AccountProcessAccess"],
        [89, "SharedDocuments"],
      ]);
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`INSERT INTO accounts(id, payload_json) VALUES ('account:keep', '{}')`;
      yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at)
        VALUES ('approval:keep', NULL, '{}', 'pending', '2026-01-01T00:00:00.000Z')`;
      expect(yield* runMigrations({ toMigrationInclusive: 89 })).toEqual([[89, "SharedDocuments"]]);
      expect(yield* sql`SELECT id FROM accounts`).toEqual([{ id: "account:keep" }]);
      expect(yield* sql`SELECT id, agent_id FROM agent_approvals`).toEqual([
        { id: "approval:keep", agent_id: null },
      ]);
      yield* sql`SELECT owner_machine FROM agents`;
      yield* sql`SELECT owner_machine FROM scheduled_tasks`;
      yield* sql`INSERT INTO shared_documents(kind, id, fields_json, clocks_json, updated_by_env)
        VALUES ('project', 'project:shared', '{}', '{}', 'local')`;
      expect(yield* runMigrations({ toMigrationInclusive: 89 })).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
