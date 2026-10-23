import {
  AgentId,
  EnvironmentId,
  ThreadId,
  VaultItemMetadata,
  VaultSecretFields,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "./Vault.ts";
import { VAULT_WITHHELD } from "./VaultRedactor.ts";
import { totp } from "./VaultTotp.ts";

const memoryStore = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) =>
      values.has(name)
        ? Effect.die(new Error("exists"))
        : Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!values.has(name)) values.set(name, new Uint8Array(bytes).fill(7));
        return values.get(name)!;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  } as ServerSecretStore.ServerSecretStore["Service"]);
};

const layer = Vault.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provide(memoryStore()),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
    }),
  ),
);

const threadId = ThreadId.make("thread:1");

describe("vault contract decoding", () => {
  it("decodes secret bodies and metadata written before card fields existed", () => {
    const decodeFields = Schema.decodeUnknownSync(VaultSecretFields);
    expect(decodeFields({ username: "u", password: "p", value: "4242" })).toEqual({
      username: "u",
      password: "p",
      value: "4242",
    });
    expect(
      decodeFields({
        cardNumber: "4242",
        cardExpiryMonth: "08",
        cardExpiryYear: "2027",
        cardCvc: "987",
        cardholderName: "Ada",
      }),
    ).toMatchObject({ cardNumber: "4242", cardExpiryYear: "2027" });

    const decodeMetadata = Schema.decodeUnknownSync(VaultItemMetadata);
    const base = {
      id: "vault:1",
      name: "Visa",
      type: "card",
      scopeProjectId: null,
      allowedDomains: [],
      policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
      fields: ["value"],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(decodeMetadata(base).cardLast4).toBeUndefined();
    expect(decodeMetadata({ ...base, fields: ["cardNumber"], cardLast4: "4242" }).cardLast4).toBe(
      "4242",
    );
  });
});

describe("Vault service", () => {
  it.effect("creates, lists metadata without secrets, uses, audits and deletes", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "GitHub",
        type: "login",
        label: "Work GitHub",
        allowedDomains: ["github.com"],
        secretFields: {
          username: "octo-user",
          password: "octo-password-123",
          totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        },
      });
      expect(item.fields).toEqual(["username", "password", "totp"]);
      const listed = yield* vault.list({});
      expect(JSON.stringify(listed)).not.toContain("octo-password-123");
      expect(JSON.stringify(listed)).not.toContain("octo-user");

      const allowed = yield* vault.use({
        itemId: item.id,
        field: "password",
        caller: { kind: "server" },
        threadId,
        action: "fill",
      });
      expect(allowed).toMatchObject({ status: "allowed", value: "octo-password-123" });

      const code = yield* vault.use({
        itemId: item.id,
        field: "totp",
        caller: { kind: "server" },
        threadId,
        action: "fill",
      });
      expect(code).toMatchObject({ status: "allowed" });
      if (code.status === "allowed") expect(code.value).toMatch(/^\d{6}$/);

      const wrongDomain = yield* vault.use({
        itemId: item.id,
        field: "password",
        caller: { kind: "server" },
        domain: "evil.test",
        enforceAllowedDomains: true,
        action: "fill",
      });
      expect(wrongDomain.status).toBe("denied");

      const resolved = yield* vault.resolveSecretByName({
        name: "GitHub",
        field: "username",
        destinationHost: "api.github.com",
        approved: false,
      });
      expect(resolved.value).toBe("octo-user");

      const usage = yield* vault.listUsage({ itemId: item.id });
      expect(usage.usage.map((entry) => entry.outcome)).toContain("allowed");
      expect(usage.usage.map((entry) => entry.outcome)).toContain("denied_domain");

      expect(yield* vault.scrubText("leaked octo-password-123 here")).toBe(
        "leaked [redacted vault secret] here",
      );

      const { deleted } = yield* vault.delete({ id: item.id });
      expect(deleted).toBe(true);
      expect((yield* vault.list({})).items).toEqual([]);
      const afterDelete = yield* vault
        .use({ itemId: item.id, field: "password", caller: { kind: "server" } })
        .pipe(Effect.flip);
      expect(afterDelete.reason).toBe("not_found");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks agents by default, then allows after the policy grants them", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      const agentId = AgentId.make("agent:1");
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agentId}, 'thread:agent', '{}', 1, 10)`;
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES ('agent:2', 'thread:agent2', '{}', 1, 10)`;
      const { item } = yield* vault.create({
        name: "Deploy key",
        type: "api_key",
        secretFields: { value: "deploy-key-value-123" },
      });
      const asked = yield* vault.use({
        itemId: item.id,
        field: "value",
        caller: { kind: "agent", agentId },
        threadId,
      });
      expect(asked.status).toBe("approval_required");
      if (asked.status === "approval_required")
        expect(asked.approvalId).toContain("approval:vault:");
      const approvals = yield* sql`SELECT status FROM agent_approvals`;
      expect(approvals).toHaveLength(1);
      const askAgain = vault.use({
        itemId: item.id,
        field: "value",
        caller: { kind: "agent", agentId },
        threadId,
      });
      const approvalIdOf = (result: Vault.VaultUseResult) =>
        result.status === "approval_required" ? result.approvalId : null;
      // A pending request is reused; a decided one does not block a new request.
      expect(approvalIdOf(yield* askAgain)).toBe(approvalIdOf(asked));
      yield* sql`UPDATE agent_approvals SET status = 'rejected'`;
      const renewed = approvalIdOf(yield* askAgain);
      expect(renewed).not.toBe(approvalIdOf(asked));
      expect(
        yield* sql`SELECT status FROM agent_approvals WHERE id = ${renewed} AND status = 'pending'`,
      ).toHaveLength(1);
      yield* sql`DELETE FROM agent_approvals WHERE status = 'rejected'`;

      yield* vault.update({
        id: item.id,
        policy: { mode: "allow", allowedAgentIds: [agentId], allowedDomains: [] },
      });
      const allowed = yield* vault.use({
        itemId: item.id,
        field: "value",
        caller: { kind: "agent", agentId },
      });
      expect(allowed).toMatchObject({ status: "allowed", value: "deploy-key-value-123" });

      const other = yield* vault.use({
        itemId: item.id,
        field: "value",
        caller: { kind: "agent", agentId: AgentId.make("agent:2") },
      });
      expect(other.status).toBe("approval_required");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a caller scope sees only its project's and environment-wide items", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const make = (name: string, scopeProjectId: string | null) =>
        vault.create({
          name,
          type: "api_key",
          scopeProjectId: scopeProjectId as never,
          secretFields: { value: `${name}-secret-value` },
        });
      yield* make("Shared", null);
      yield* make("Mine", "label:a");
      const { item: theirs } = yield* make("Theirs", "label:b");
      const scope = { projectId: "label:a" };
      expect((yield* vault.list({}, scope)).items.map((item) => item.name)).toEqual([
        "Mine",
        "Shared",
      ]);
      expect((yield* vault.list({ scopeProjectId: "label:b" as never }, scope)).items).toHaveLength(
        2,
      );
      expect((yield* vault.list({}, { projectId: null })).items.map((i) => i.name)).toEqual([
        "Shared",
      ]);
      for (const target of [{ itemId: theirs.id }, { name: "Theirs" }]) {
        const error = yield* vault
          .use({ ...target, field: "value", caller: { kind: "server" }, callerScope: scope })
          .pipe(Effect.flip);
        expect(error.reason).toBe("not_found");
      }
      expect((yield* vault.delete({ id: theirs.id }, scope).pipe(Effect.flip)).reason).toBe(
        "not_found",
      );
      expect((yield* vault.list({})).items).toHaveLength(3);
      expect(
        yield* vault.use({
          name: "Mine",
          field: "value",
          caller: { kind: "server" },
          callerScope: scope,
        }),
      ).toMatchObject({ status: "allowed", value: "Mine-secret-value" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks an agentless thread by default and fills once allowed or approved", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      const caller = { kind: "thread", threadId } as const;
      const { item } = yield* vault.create({
        name: "GitHub",
        type: "login",
        allowedDomains: ["github.com"],
        secretFields: { password: "octo-password-123" },
      });
      const fill = vault.use({
        itemId: item.id,
        field: "password",
        caller,
        threadId,
        domain: "github.com",
        enforceAllowedDomains: true,
        action: "fill",
      });
      const asked = yield* fill;
      expect(asked.status).toBe("approval_required");
      const pending = yield* sql<{
        agent_id: string | null;
        status: string;
      }>`SELECT agent_id, status FROM agent_approvals`;
      expect(pending).toEqual([{ agent_id: null, status: "pending" }]);

      // The owner's approval is the thread's grant, for this thread only.
      yield* sql`UPDATE agent_approvals SET status = 'approved', decided_at = '2026-01-01T00:00:00.000Z'`;
      expect(yield* fill).toMatchObject({ status: "allowed", value: "octo-password-123" });
      expect(
        (yield* vault.use({
          itemId: item.id,
          field: "password",
          caller: { kind: "thread", threadId: "thread:other" },
          domain: "github.com",
        })).status,
      ).toBe("approval_required");

      yield* vault.update({
        id: item.id,
        policy: { mode: "allow", allowedAgentIds: [], allowedDomains: ["github.com"] },
      });
      expect(yield* fill).toMatchObject({ status: "allowed", value: "octo-password-123" });
      expect(
        (yield* vault.use({
          itemId: item.id,
          field: "password",
          caller,
          domain: "evil.test",
          enforceAllowedDomains: true,
        })).status,
      ).toBe("denied");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stores a card in encrypted card fields and fills each by field", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "Visa",
        type: "card",
        label: "Personal",
        allowedDomains: ["shop.test"],
        secretFields: {
          cardNumber: "4242 4242 4242 4242",
          cardExpiryMonth: "08",
          cardExpiryYear: "2027",
          cardCvc: "987",
          cardholderName: "Ada Cardholder",
        },
      });
      expect(item.fields).toEqual(["cardNumber", "cardExpiry", "cardCvc", "cardholderName"]);
      expect(item.cardLast4).toBe("4242");
      expect(item.label).toBe("Personal");

      const listed = yield* vault.list({});
      const listedJson = JSON.stringify(listed);
      expect(listedJson).toContain("4242");
      expect(listedJson).not.toContain("4242 4242");
      expect(listedJson).not.toContain("4242424242424242");
      expect(listedJson).not.toContain("Ada Cardholder");
      expect(listedJson).not.toContain("08/2027");
      expect(Object.values(listed.items[0]!)).not.toContain("987");

      const fill = (field: "cardNumber" | "cardExpiry" | "cardCvc" | "cardholderName") =>
        vault.use({ itemId: item.id, field, caller: { kind: "server" }, threadId, action: "fill" });
      expect(yield* fill("cardNumber")).toMatchObject({
        status: "allowed",
        value: "4242 4242 4242 4242",
      });
      expect(yield* fill("cardExpiry")).toMatchObject({ status: "allowed", value: "08/27" });
      expect(yield* fill("cardCvc")).toMatchObject({ status: "allowed", value: "987" });
      expect(yield* fill("cardholderName")).toMatchObject({
        status: "allowed",
        value: "Ada Cardholder",
      });

      const wrongDomain = yield* vault.use({
        itemId: item.id,
        field: "cardNumber",
        caller: { kind: "server" },
        domain: "evil.test",
        enforceAllowedDomains: true,
        action: "fill",
      });
      expect(wrongDomain.status).toBe("denied");

      // Every echo shape of a card secret is scrubbed, short ones included.
      expect(
        yield* vault.scrubText(
          "num 4242424242424242 grouped 4242 4242 4242 4242 cvc 987 exp 08/27 long 08/2027 name Ada Cardholder",
        ),
      ).toBe(
        "num [redacted vault secret] grouped [redacted vault secret] cvc [redacted vault secret] exp [redacted vault secret] long [redacted vault secret] name [redacted vault secret]",
      );
      expect(yield* vault.scrubText("order 9876 is not the cvc")).toBe("order 9876 is not the cvc");

      const updated = yield* vault.update({
        id: item.id,
        secretFields: { cardNumber: "5555 5555 5555 4444" },
      });
      expect(updated.item.cardLast4).toBe("4444");
      expect(updated.item.fields).toEqual([
        "cardNumber",
        "cardExpiry",
        "cardCvc",
        "cardholderName",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves legacy card-shaped items on the old fields, undecayed", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      // Written by the old UI: number in value, CVC in password, name in
      // username, expiry in the plaintext label. No silent migration.
      const { item } = yield* vault.create({
        name: "Old Visa",
        type: "card",
        label: "08/27",
        secretFields: { username: "Ada Old", password: "123", value: "4242" },
      });
      expect(item.fields).toEqual(["username", "password", "value"]);
      expect(item.cardLast4).toBeUndefined();
      expect(item.label).toBe("08/27");
      expect(
        yield* vault.use({ itemId: item.id, field: "value", caller: { kind: "server" } }),
      ).toMatchObject({ status: "allowed", value: "4242" });
      const missing = yield* vault
        .use({ itemId: item.id, field: "cardNumber", caller: { kind: "server" } })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("field_missing");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("withholds tool output when the secrets to scrub cannot be loaded", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      yield* vault.create({
        name: "Token",
        type: "api_key",
        secretFields: { value: "token-value-123" },
      });
      yield* sql`ALTER TABLE vault_items RENAME TO vault_items_gone`;
      expect(yield* vault.scrubText("leaked token-value-123")).toBe(VAULT_WITHHELD);
      expect(yield* vault.scrubValue({ output: "leaked token-value-123", exitCode: 0 })).toEqual({
        output: VAULT_WITHHELD,
        exitCode: 0,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a scrub reload that races a write never publishes the older snapshot", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      for (const n of [1, 2, 3, 4, 5])
        yield* vault.create({
          name: `Item ${n}`,
          type: "api_key",
          secretFields: { value: `item-value-${n}` },
        });
      // The reload awaits decryption once per item while the new item is written.
      yield* Effect.all(
        [
          vault.scrubText("warm the cache"),
          vault.create({
            name: "Second",
            type: "api_key",
            secretFields: { value: "second-value-2" },
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* vault.scrubText("second-value-2")).toBe("[redacted vault secret]");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("scrubs short passwords as whole tokens and delivered TOTP codes for good", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      const { item } = yield* vault.create({
        name: "Short",
        type: "login",
        secretFields: { password: "p4ss", totpSecret: secret },
      });
      expect(yield* vault.scrubText("pw p4ss, not p4ssword")).toBe(
        "pw [redacted vault secret], not p4ssword",
      );
      yield* TestClock.setTime(1_800_000_015_000);
      const filled = yield* vault.use({
        itemId: item.id,
        field: "totp",
        caller: { kind: "server" },
      });
      const code = filled.status === "allowed" ? filled.value : "";
      // Long after its window, the code that was actually filled is still scrubbed.
      yield* TestClock.setTime(1_800_000_015_000 + 10 * 60_000);
      expect(yield* vault.scrubText(`code ${code}`)).toBe("code [redacted vault secret]");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("scrubs the TOTP codes valid around now", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      yield* vault.create({ name: "2FA", type: "login", secretFields: { totpSecret: secret } });
      const atMs = 1_800_000_015_000;
      yield* TestClock.setTime(atMs);
      const [previous, current, next] = [-30_000, 0, 30_000].map((offset) =>
        totp(secret, { atMs: atMs + offset }),
      );
      expect(yield* vault.scrubText(`codes ${previous} ${current} ${next}`)).toBe(
        "codes [redacted vault secret] [redacted vault secret] [redacted vault secret]",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("updates secret fields by merging and dropping emptied fields", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "Note",
        type: "note",
        secretFields: { value: "first-note-value" },
      });
      const updated = yield* vault.update({ id: item.id, secretFields: { value: "" } });
      expect(updated.item.fields).toEqual([]);
      const missing = yield* vault
        .use({ itemId: item.id, field: "value", caller: { kind: "server" } })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("field_missing");
    }).pipe(Effect.provide(layer)),
  );
});
