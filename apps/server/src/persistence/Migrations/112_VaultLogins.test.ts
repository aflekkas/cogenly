import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provide(NodeServices.layer),
);

const AT = "2026-10-01T00:00:00.000Z";

describe("112_VaultLogins", () => {
  it.effect(
    "moves old-default ask rules to the new default, keeps owner choices, and lets logins share a site name",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 111 });
        const insert = (
          id: string,
          name: string,
          type: string,
          policy: unknown,
          attachment: string | null = null,
        ) =>
          sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at, sync_attachment_json)
            VALUES (${id}, ${name}, ${type}, NULL, '{"fields":["password"]}', ${JSON.stringify(policy)}, '["theadso.my.site.com"]', 'x', '[]', ${AT}, ${AT}, ${attachment})`;
        // The 0.3.2 ADSO item: saved through request_secret with the old "ask" default.
        yield* insert("vault:adso", "ADSO member portal", "login", {
          mode: "ask",
          allowedAgentIds: [],
          allowedDomains: [],
        });
        yield* insert("vault:chosen", "Bank", "login", {
          mode: "ask",
          allowedAgentIds: [],
          allowedDomains: [],
          ownerSet: true,
        });
        yield* insert("vault:one-agent", "Shop", "login", {
          mode: "allow",
          allowedAgentIds: ["agent:1"],
          allowedDomains: [],
        });
        yield* insert(
          "vault:token",
          "Slack token",
          "api_key",
          { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
          '{"kind":"oauth"}',
        );

        expect(yield* runMigrations({ toMigrationInclusive: 112 })).toEqual([[112, "VaultLogins"]]);

        const modes = yield* sql<{
          id: string;
          mode: string;
        }>`SELECT id, json_extract(policy_json, '$.mode') AS mode FROM vault_items ORDER BY id`;
        expect(modes).toEqual([
          { id: "vault:adso", mode: "allow" },
          { id: "vault:chosen", mode: "ask" },
          { id: "vault:one-agent", mode: "allow" },
          { id: "vault:token", mode: "ask" },
        ]);
        const adso = yield* sql<{
          policy_json: string;
        }>`SELECT policy_json FROM vault_items WHERE id = 'vault:adso'`;
        expect(JSON.parse(adso[0]!.policy_json)).toEqual({
          mode: "allow",
          allowedAgentIds: [],
          allowedDomains: [],
        });

        // A second login for the same site may share its name; other types may not.
        yield* insert("vault:adso-2", "ADSO member portal", "login", {
          mode: "allow",
          allowedAgentIds: [],
          allowedDomains: [],
        });
        const duplicate = yield* insert("vault:token-2", "Slack token", "api_key", {
          mode: "allow",
          allowedAgentIds: [],
          allowedDomains: [],
        }).pipe(Effect.flip);
        expect(String(duplicate.cause)).toMatch(/unique/i);
        yield* sql`INSERT INTO vault_login_integrations(item_id, integration_id, linked_at) VALUES ('vault:adso', 'integration:1', ${AT})`;
      }).pipe(Effect.provide(layer)),
  );
});
