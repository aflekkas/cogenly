import {
  AgentId,
  EnvironmentId,
  ProjectLabelId,
  ThreadId,
  VaultItemMetadata,
  VaultSecretFields,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
        caller: { kind: "human" },
        threadId,
        action: "fill",
      });
      expect(allowed).toMatchObject({ status: "allowed", value: "octo-password-123" });

      const code = yield* vault.use({
        itemId: item.id,
        field: "totp",
        caller: { kind: "human" },
        threadId,
        action: "fill",
      });
      expect(code).toMatchObject({ status: "allowed" });
      if (code.status === "allowed") expect(code.value).toMatch(/^\d{6}$/);

      const wrongDomain = yield* vault.use({
        itemId: item.id,
        field: "password",
        caller: { kind: "human" },
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
        .use({ itemId: item.id, field: "password", caller: { kind: "human" } })
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

  it.effect("keeps a project's items out of reach of callers in other projects", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const labelA = ProjectLabelId.make("label:a");
      const labelB = ProjectLabelId.make("label:b");
      const { item: secretOfB } = yield* vault.create({
        name: "B token",
        type: "api_key",
        scopeProjectId: labelB,
        secretFields: { value: "b-token-value-123" },
      });
      yield* vault.create({
        name: "Shared",
        type: "api_key",
        secretFields: { value: "shared-value-123" },
      });
      const inA = { projectId: labelA };
      const fill = (input: { readonly itemId?: typeof secretOfB.id; readonly name?: string }) =>
        vault.use({ ...input, field: "value", caller: { kind: "human" }, access: inA }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      expect((yield* vault.list({}, inA)).items.map((item) => item.name)).toEqual(["Shared"]);
      expect((yield* vault.list({ scopeProjectId: labelB }, inA)).items.map((i) => i.name)).toEqual(
        ["Shared"],
      );
      expect((yield* vault.list({}, { projectId: null })).items.map((i) => i.name)).toEqual([
        "Shared",
      ]);
      expect(yield* fill({ itemId: secretOfB.id })).toBe("not_found");
      expect(yield* fill({ name: "B token" })).toBe("not_found");
      expect((yield* vault.delete({ id: secretOfB.id }, inA)).deleted).toBe(false);

      // Its own project, and the owner, still reach it.
      expect(
        yield* vault.use({
          itemId: secretOfB.id,
          field: "value",
          caller: { kind: "human" },
          access: { projectId: labelB },
        }),
      ).toMatchObject({ status: "allowed" });
      expect((yield* vault.list({})).items).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks again after a decided approval, reusing only a pending one", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      const agentId = AgentId.make("agent:1");
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agentId}, 'thread:agent', '{}', 1, 10)`;
      const { item } = yield* vault.create({
        name: "Deploy key",
        type: "api_key",
        secretFields: { value: "deploy-key-value-123" },
      });
      const ask = () =>
        vault.use({
          itemId: item.id,
          field: "value",
          caller: { kind: "agent", agentId },
          threadId,
        });
      const first = yield* ask();
      const again = yield* ask();
      expect(first.status === "approval_required" && first.approvalId).toBeTruthy();
      expect(again.status === "approval_required" && again.approvalId).toBe(
        first.status === "approval_required" && first.approvalId,
      );

      // The owner rejects (or approves, then revokes the grant): the next use asks afresh.
      yield* sql`UPDATE agent_approvals SET status = 'rejected', decided_by = 'user'`;
      const afterDecision = yield* ask();
      expect(afterDecision.status).toBe("approval_required");
      if (afterDecision.status === "approval_required" && first.status === "approval_required")
        expect(afterDecision.approvalId).not.toBe(first.approvalId);
      const pending = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM agent_approvals WHERE status = 'pending'`;
      expect(pending[0]?.n).toBe(1);
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
        vault.use({ itemId: item.id, field, caller: { kind: "human" }, threadId, action: "fill" });
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
        caller: { kind: "human" },
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
        yield* vault.use({ itemId: item.id, field: "value", caller: { kind: "human" } }),
      ).toMatchObject({ status: "allowed", value: "4242" });
      const missing = yield* vault
        .use({ itemId: item.id, field: "cardNumber", caller: { kind: "human" } })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("field_missing");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps scrubbing a delivered value after its item is rotated or deleted", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "Token",
        type: "api_key",
        secretFields: { value: "first-token-value" },
      });
      const fill = () => vault.use({ itemId: item.id, field: "value", caller: { kind: "human" } });
      yield* fill();
      yield* vault.update({ id: item.id, secretFields: { value: "second-token-value" } });
      yield* fill();
      yield* vault.delete({ id: item.id });
      expect(yield* vault.scrubText("page kept first-token-value and second-token-value")).toBe(
        "page kept [redacted vault secret] and [redacted vault secret]",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("scrubs short passwords and filled one-time codes as whole tokens", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "Router",
        type: "login",
        secretFields: { password: "pw12", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
      });
      yield* TestClock.setTime(1_800_000_015_000);
      const code = yield* vault.use({ itemId: item.id, field: "totp", caller: { kind: "human" } });
      if (code.status !== "allowed") return expect.fail("the code should fill");
      // Long after its window, the code that was typed is still scrubbed.
      yield* TestClock.setTime(1_800_000_015_000 + 10 * 60_000);
      expect(
        yield* vault.scrubText(`pw ${"pw12"} not pw123, code ${code.value} not ${code.value}9`),
      ).toBe(
        `pw [redacted vault secret] not pw123, code [redacted vault secret] not ${code.value}9`,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a scrub load that overlaps a write does not publish a stale set", () => {
    const values = new Map<string, Uint8Array>();
    // Holds the next key-pair read until the test opens it.
    const gate: { reached?: Deferred.Deferred<void>; open?: Deferred.Deferred<void> } = {};
    const store = Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) =>
        Effect.gen(function* () {
          if (gate.reached && gate.open) {
            yield* Deferred.succeed(gate.reached, undefined);
            yield* Deferred.await(gate.open);
          }
          return Option.fromUndefinedOr(values.get(name));
        }),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
    });
    return Effect.gen(function* () {
      const id = yield* Vault.Vault.pipe(
        Effect.flatMap((vault) =>
          vault.create({ name: "A", type: "api_key", secretFields: { value: "alpha-value-123" } }),
        ),
        Effect.map(({ item }) => item.id),
        Effect.provide(Vault.layer),
      );
      // A second instance has no key pair cached, so its load stops at the gate.
      yield* Effect.gen(function* () {
        const vault = yield* Vault.Vault;
        gate.reached = yield* Deferred.make<void>();
        gate.open = yield* Deferred.make<void>();
        const loading = yield* vault.scrubText("warm").pipe(Effect.forkChild);
        yield* Deferred.await(gate.reached);
        yield* vault.delete({ id });
        yield* Deferred.succeed(gate.open, undefined);
        yield* Fiber.join(loading);
        // Never delivered, so once deleted there is nothing left to scrub.
        expect(yield* vault.scrubText("alpha-value-123")).toBe("alpha-value-123");
      }).pipe(Effect.provide(Vault.layer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          store,
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
          }),
        ).pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    );
  });

  it.effect("a terminal's output redactor follows vault writes while it runs", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      yield* vault.create({
        name: "A",
        type: "api_key",
        secretFields: { value: "alpha-value-123" },
      });
      const redact = yield* vault.outputRedactor;
      expect(redact("x alpha-val") + redact("ue-123 y")).toBe("x [redacted vault secret] y");
      yield* vault.create({
        name: "B",
        type: "api_key",
        secretFields: { value: "bravo-value-123" },
      });
      expect(redact("bravo-value-123 ") + redact("", true)).toBe("[redacted vault secret] ");
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
        .use({ itemId: item.id, field: "value", caller: { kind: "human" } })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("field_missing");
    }).pipe(Effect.provide(layer)),
  );
});
