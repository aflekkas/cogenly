import * as Vault from "../vault/Vault.ts";
import { AccountId, ProjectLabelId, VaultItemId } from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { migrateVaultAccounts } from "../persistence/Migrations/087_Accounts.ts";
import * as Accounts from "./Accounts.ts";

const layer = Accounts.layer.pipe(
  Layer.provide(Layer.mock(Vault.Vault)({})),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const project = ProjectLabelId.make("project:one");
const other = ProjectLabelId.make("project:two");
const at = "2026-10-23T00:00:00.000Z";
const seed = (id: string, scope: string | null, type = "api_key") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at) VALUES (${id}, ${id}, ${type}, ${scope}, '{"fields":["username","value"]}', '{"mode":"ask","allowedAgentIds":[],"allowedDomains":[]}', '[]', 'opaque-encrypted-identity', '["opaque-wrap"]', ${at}, ${at})`;
  });

describe("Accounts", () => {
  it.effect("backfills repeatably without reading identities or changing encrypted envelopes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const accounts = yield* Accounts.Accounts;
      yield* seed("legacy", project, "login");
      yield* seed("note", null, "note");
      const before = yield* sql`SELECT * FROM vault_items ORDER BY id`;
      yield* migrateVaultAccounts;
      yield* migrateVaultAccounts;
      expect(yield* sql`SELECT * FROM vault_items ORDER BY id`).toEqual(before);
      const result = yield* accounts.list({ scopeProjectId: project });
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.every((a) => a.displayLabel === "Other credentials")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("opaque");
      expect(result.accounts.find((a) => a.id === "account:legacy")?.credentials[0]).toMatchObject({
        id: "credential:legacy",
        vaultItemId: "legacy",
        kind: "login",
      });
      yield* accounts.update({
        id: AccountId.make("account:legacy"),
        scopeProjectId: project,
        displayLabel: "Chosen public label",
        serviceId: "cloudflare",
      });
      yield* migrateVaultAccounts;
      expect(
        (yield* accounts.get({ id: AccountId.make("account:legacy"), scopeProjectId: project }))
          .account.displayLabel,
      ).toBe("Chosen public label");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "filters every lookup, prevents scope widening, preserves multiple credentials and legacy ids",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        yield* seed("token", project);
        yield* seed("login", project, "login");
        const { account } = yield* accounts.create({
          scopeProjectId: project,
          serviceId: "github",
          displayLabel: "Work",
          credentials: [
            {
              kind: "token",
              vaultItemId: VaultItemId.make("token"),
              portability: "shared",
              deliveryBindings: ["cli"],
              policy: { processExposure: "ask" },
            },
            {
              kind: "login",
              vaultItemId: VaultItemId.make("login"),
              portability: "shared",
              deliveryBindings: ["browser"],
              policy: { processExposure: "ask" },
            },
          ],
        });
        expect(account.credentials).toHaveLength(2);
        expect((yield* accounts.list({ scopeProjectId: other })).accounts).toEqual([]);
        expect((yield* accounts.list({ scopeProjectId: null })).accounts).toEqual([]);
        for (const op of [
          accounts.get({ id: account.id, scopeProjectId: other }).pipe(Effect.asVoid),
          accounts
            .update({ id: account.id, scopeProjectId: other, displayLabel: "stolen" })
            .pipe(Effect.asVoid),
          accounts.disconnect({ id: account.id, scopeProjectId: other }).pipe(Effect.asVoid),
        ]) {
          expect(yield* op.pipe(Effect.flip)).toMatchObject({ reason: "not_found" });
        }
        expect(
          yield* accounts
            .create({
              scopeProjectId: null,
              serviceId: "github",
              displayLabel: "Widen",
              credentials: [{ ...account.credentials[0]! }],
            })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        expect(
          (yield* accounts.get({
            id: account.id,
            scopeProjectId: project,
          })).account.credentials.map((c) => c.vaultItemId),
        ).toEqual(["token", "login"]);
        yield* accounts.disconnect({ id: account.id, scopeProjectId: project });
        expect((yield* accounts.list({ scopeProjectId: project })).accounts).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT id FROM vault_items WHERE deleted_at IS NULL`).toHaveLength(2);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "does not resurrect a disconnected migrated account or advertise deleted vault items",
    () =>
      Effect.gen(function* () {
        yield* seed("legacy", project);
        yield* migrateVaultAccounts;
        const accounts = yield* Accounts.Accounts;
        const key = { id: AccountId.make("account:legacy"), scopeProjectId: project };
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE vault_items SET deleted_at = ${at} WHERE id = 'legacy'`;
        expect((yield* accounts.get(key)).account.credentials).toEqual([]);
        yield* accounts.disconnect(key);
        yield* migrateVaultAccounts;
        expect(yield* accounts.get(key).pipe(Effect.flip)).toMatchObject({ reason: "not_found" });
      }).pipe(Effect.provide(layer)),
  );
});
