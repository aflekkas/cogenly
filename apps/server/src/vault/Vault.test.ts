import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  AgentId,
  EnvironmentId,
  ProjectLabelId,
  ThreadId,
  VaultItemMetadata,
  VaultSecretFields,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type * as Statement from "effect/sql/Statement";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "./Vault.ts";
import { VAULT_WITHHELD } from "./VaultRedactor.ts";
import { totp } from "./VaultTotp.ts";

import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as CardNotifications from "../orchestration-v2/InlineCardNotifications.ts";
import * as Workspace from "../agents/AgentWorkspaceService.ts";
import * as ApprovalChanges from "../agents/ApprovalChanges.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Agents from "../agents/AgentService.ts";
import * as Work from "../work/WorkHandoffService.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";

class Decisions extends Context.Service<
  Decisions,
  Array<{ threadId: ThreadId; summary: string }>
>()("cogenly-server/vault/Vault.test/Decisions") {}
const decisionsLayer = Layer.unwrap(
  Effect.sync(() => {
    const decisions: Array<{ threadId: ThreadId; summary: string }> = [];
    return Layer.mergeAll(
      Layer.succeed(Decisions, decisions),
      Layer.succeed(CardNotifications.InlineCardNotifications, {
        answered: (input) =>
          Effect.sync(() => {
            decisions.push(input);
          }),
      }),
    );
  }),
);

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

const dependencies = Layer.mergeAll(
  Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  NodeCrypto.layer,
  memoryStore(),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
  }),
);
const layer = Vault.layer.pipe(Layer.provideMerge(dependencies));

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
      expect(JSON.stringify(listed)).not.toContain("GEZDGNBVGY3TQOJQ");
      // A login's username is display text, like an integration's account label.
      expect(listed.items[0]?.username).toBe("octo-user");
      expect(listed.sites).toEqual([
        {
          host: "github.com",
          siteName: "GitHub",
          logins: [
            { id: item.id, label: "Work GitHub", username: "octo-user", missingUsername: false },
          ],
        },
      ]);

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
      expect(
        yield* vault
          .resolveSecretByName({
            name: "GitHub",
            field: "password",
            destinationHost: "evil.test",
            approved: true,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "domain_not_allowed" });

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

  it.effect("a local policy update preserves a peer revision arriving before its transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let peerProjection: ReturnType<Vault.Vault["Service"]["applySynced"]> | undefined;
      const intercepted = new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== "withTransaction") return Reflect.get(target, property, receiver);
          return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.suspend(() => {
              const projection = peerProjection;
              peerProjection = undefined;
              return projection
                ? projection.pipe(Effect.andThen(sql.withTransaction(effect)))
                : sql.withTransaction(effect);
            });
        },
      });
      yield* Effect.gen(function* () {
        const vault = yield* Vault.Vault;
        const { item } = yield* vault.create({
          name: "Sign-in",
          type: "api_key",
          secretFields: { value: "old-token" },
        });
        peerProjection = vault.applySynced({
          itemId: item.id,
          sourceLabel: "Peer",
          extras: {},
          payload: {
            name: item.name,
            type: item.type,
            scopeProjectId: null,
            allowedDomains: [],
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            secretFields: { value: "peer-token", password: "peer-refresh" },
            attachment: { client: "peer-client" },
          },
        });
        const policy = { mode: "allow" as const, allowedAgentIds: [], allowedDomains: [] };
        const updated = yield* vault.update({ id: item.id, policy });
        expect(updated.item.policy).toEqual(policy);
        expect(updated.item.fields).toEqual(["password", "value"]);
        expect(yield* vault.credentialRevision(item.id)).toBe(2);
        expect(yield* vault.getSyncAttachment(item.id)).toEqual({ client: "peer-client" });
        expect(
          yield* vault.use({ itemId: item.id, field: "value", caller: { kind: "server" } }),
        ).toMatchObject({ status: "allowed", value: "peer-token" });
      }).pipe(
        Effect.provide(
          Vault.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted))),
        ),
      );
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("thread project scope filters lists and both id and name use", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const project = ProjectLabelId.make("project:a");
      const other = ProjectLabelId.make("project:b");
      const policy = { mode: "allow" as const, allowedAgentIds: [], allowedDomains: [] };
      const { item: hidden } = yield* vault.create({
        name: "Hidden",
        type: "api_key",
        scopeProjectId: other,
        policy,
        secretFields: { value: "hidden-secret" },
      });
      yield* vault.create({
        name: "Visible",
        type: "api_key",
        scopeProjectId: project,
        policy,
        secretFields: { value: "visible-secret" },
      });
      yield* vault.create({
        name: "Shared",
        type: "api_key",
        policy,
        secretFields: { value: "shared-secret" },
      });
      expect(
        (yield* vault.list({ scopeProjectId: other }, threadId)).items.map((i) => i.name),
      ).toEqual(["Shared", "Visible"]);
      expect((yield* vault.list({}, ThreadId.make("unfiled"))).items.map((i) => i.name)).toEqual([
        "Shared",
      ]);
      for (const lookup of [{ itemId: hidden.id }, { name: hidden.name }]) {
        const error = yield* vault
          .use({
            ...lookup,
            field: "value",
            caller: { kind: "thread", threadId },
            threadId,
            scopeProjectId: other,
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("not_found");
      }
      expect(
        (yield* vault.use({
          name: "Visible",
          field: "value",
          caller: { kind: "thread", threadId },
          threadId,
        })).status,
      ).toBe("allowed");
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(ProjectFiles.ProjectFiles)({
              folderForThread: (id) =>
                Effect.succeed(
                  id === threadId ? ({ labelId: ProjectLabelId.make("project:a") } as never) : null,
                ),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("an explicit Ask first asks the owner and approval grants only that thread", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const workspace = yield* Workspace.AgentWorkspaceService;
      const { item } = yield* vault.create({
        name: "Thread login",
        type: "login",
        allowedDomains: ["example.com"],
        policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
        secretFields: { password: "thread-password" },
      });
      const request = {
        itemId: item.id,
        field: "password" as const,
        caller: { kind: "thread" as const, threadId },
        threadId,
        domain: "example.com",
        enforceAllowedDomains: true,
      };
      const asked = yield* vault.use(request);
      expect(asked.status).toBe("approval_required");
      if (asked.status !== "approval_required" || !asked.approvalId)
        throw new Error("Missing approval");
      yield* workspace.approve(asked.approvalId);
      expect(yield* vault.use(request)).toMatchObject({
        status: "allowed",
        value: "thread-password",
      });
      expect(
        (yield* vault.use({
          ...request,
          caller: { kind: "thread", threadId: ThreadId.make("other") },
        })).status,
      ).toBe("approval_required");
      // Outside the item's sites the owner decides again.
      expect((yield* vault.use({ ...request, domain: "evil.test" })).status).toBe(
        "approval_required",
      );
    }).pipe(
      Effect.provide(
        Workspace.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentStore.AgentStore)({}),
              Layer.mock(Agents.AgentService)({}),
              Layer.mock(Work.WorkHandoffService)({}),
              Layer.mock(Schedules.ScheduledTaskService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("lists a thread's fill approvals for that thread only and streams decisions", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const workspace = yield* Workspace.AgentWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const decisions = yield* Decisions;
      const other = ThreadId.make("thread:other");
      const settled = ThreadId.make("thread:settled");
      for (const [id, payload] of [
        [threadId, "{}"],
        [other, "{}"],
        [settled, '{"settledOverride":"settled"}'],
      ] as const)
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'project:1', 'Thread', 'claude', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${payload})`;
      const { item } = yield* vault.create({
        name: "GitHub",
        type: "login",
        allowedDomains: ["github.com"],
        policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
        secretFields: { password: "github-password" },
      });
      const fill = (caller: ThreadId) =>
        vault.use({
          itemId: item.id,
          field: "password",
          caller: { kind: "thread", threadId: caller },
          threadId: caller,
          domain: "github.com",
          enforceAllowedDomains: true,
          action: "fill",
        });
      const pendingIds = (thread?: ThreadId) =>
        workspace
          .listThreadApprovals(thread)
          .pipe(Effect.map(({ approvals }) => approvals.map((approval) => approval.id)));

      // The stream's first read is in before the fill, so its next value is the change.
      const firstRead = yield* Deferred.make<void>();
      const streamed = yield* workspace.subscribeThreadApprovals.pipe(
        Stream.tap(() => Deferred.succeed(firstRead, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstRead);

      const asked = yield* fill(threadId);
      if (asked.status !== "approval_required" || !asked.approvalId)
        throw new Error("Expected an approval");
      expect(asked.message).toContain("approval card in this thread");
      expect(yield* pendingIds(threadId)).toEqual([asked.approvalId]);
      expect(yield* pendingIds(other)).toEqual([]);
      const [before, after] = Array.from(yield* Fiber.join(streamed));
      expect(before?.approvals).toEqual([]);
      expect(after?.approvals.map((approval) => approval.id)).toEqual([asked.approvalId]);

      // Denying keeps the fill refused; asking again raises a fresh card that says so.
      yield* workspace.reject(asked.approvalId);
      expect(decisions.at(-1)?.summary).toContain("Approval denied");
      expect(decisions.at(-1)?.threadId).toBe(threadId);
      expect(yield* pendingIds(threadId)).toEqual([]);
      const again = yield* fill(threadId);
      if (again.status !== "approval_required" || !again.approvalId)
        throw new Error("Expected a fresh approval");
      expect(again.approvalId).not.toBe(asked.approvalId);
      expect(again.message).toContain("declined");

      yield* workspace.approve(again.approvalId);
      expect(decisions.at(-1)?.summary).toContain("Approval granted");
      expect(decisions.at(-1)?.summary).toContain("github.com");
      expect(yield* pendingIds()).toEqual([]);
      expect(yield* fill(threadId)).toMatchObject({ status: "allowed", value: "github-password" });
      expect((yield* fill(other)).status).toBe("approval_required");
      expect((yield* pendingIds(other)).length).toBe(1);

      // A settled thread leaves no card behind.
      expect((yield* fill(settled)).status).toBe("approval_required");
      expect(yield* pendingIds(settled)).toEqual([]);
    }).pipe(
      Effect.provide(
        Workspace.layer.pipe(
          Layer.provideMerge(decisionsLayer),
          Layer.provideMerge(layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentStore.AgentStore)({}),
              Layer.mock(Agents.AgentService)({}),
              Layer.mock(Work.WorkHandoffService)({}),
              Layer.mock(Schedules.ScheduledTaskService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            ),
          ),
          Layer.provideMerge(ApprovalChanges.layer),
        ),
      ),
    ),
  );

  it.effect("lists an owner thread's CLI token exposure approval", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.AgentWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, 'project:1', 'Thread', 'claude', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{}')`;
      const exposure = {
        actionKind: "vault_use",
        payload: {
          vaultItemId: "vault:token",
          vaultItemName: "CLI token · GitHub",
          field: "value",
          domain: null,
          threadId,
          processExposure: {
            accountId: "account:1",
            credentialId: "credential:1",
            credentialRevision: 1,
            threadId,
            projectKey: "repository:project:1",
            message: "The agent and the commands it runs can read this token.",
          },
        },
      };
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES ('agent:1', 'thread:agent', '{}', 1, 10)`;
      yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at) VALUES ('approval:account:1', NULL, ${JSON.stringify(exposure)}, 'pending', ${at})`;
      yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at) VALUES ('approval:agent', 'agent:1', ${JSON.stringify(exposure)}, 'pending', ${at})`;
      const { approvals } = yield* workspace.listThreadApprovals(threadId);
      // An agent's own approval stays in its workspace.
      expect(approvals.map((approval) => approval.id)).toEqual(["approval:account:1"]);
    }).pipe(
      Effect.provide(
        Workspace.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentStore.AgentStore)({}),
              Layer.mock(Agents.AgentService)({}),
              Layer.mock(Work.WorkHandoffService)({}),
              Layer.mock(Schedules.ScheduledTaskService)({}),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "asks agents when the owner chose Ask first, then allows after the policy grants them",
    () =>
      Effect.gen(function* () {
        const vault = yield* Vault.Vault;
        const sql = yield* SqlClient.SqlClient;
        const agentId = AgentId.make("agent:1");
        yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agentId}, 'thread:agent', '{}', 1, 10)`;
        yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES ('agent:2', 'thread:agent2', '{}', 1, 10)`;
        const { item } = yield* vault.create({
          name: "Deploy key",
          type: "api_key",
          policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
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
        [VAULT_WITHHELD]: 0,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("withholds tool output when a local item cannot be decrypted", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      yield* vault.create({
        name: "Token",
        type: "api_key",
        secretFields: { value: "token-value-123" },
      });
      const { item } = yield* vault.create({
        name: "Broken",
        type: "api_key",
        secretFields: { value: "broken-value-456" },
      });
      yield* sql`UPDATE vault_items SET ciphertext = ${JSON.stringify({ nonce: "AAAA", ciphertext: "AAAA" })} WHERE id = ${item.id}`;
      expect(yield* vault.scrubText("leaked token-value-123 broken-value-456")).toBe(
        VAULT_WITHHELD,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips a peer's item not wrapped for this machine and still scrubs local ones", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      yield* vault.create({
        name: "Token",
        type: "api_key",
        secretFields: { value: "token-value-123" },
      });
      const { item } = yield* vault.create({
        name: "Peer",
        type: "api_key",
        secretFields: { value: "peer-value-789" },
      });
      const [row] = yield* sql<{
        wrapped_keys_json: string;
      }>`SELECT wrapped_keys_json FROM vault_items WHERE id = ${item.id}`;
      const peerWrapped = (JSON.parse(row!.wrapped_keys_json) as Array<object>).map((entry) => ({
        ...entry,
        environmentId: "environment:peer",
      }));
      yield* sql`UPDATE vault_items SET wrapped_keys_json = ${JSON.stringify(peerWrapped)} WHERE id = ${item.id}`;
      expect(yield* vault.scrubText("leaked token-value-123")).toBe(
        "leaked [redacted vault secret]",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reuses pending approvals but creates a fresh request after revocation", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault,
        sql = yield* SqlClient.SqlClient;
      const { item } = yield* vault.create({
        name: "revoke",
        type: "note",
        policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
        secretFields: { value: "revoked-secret" },
      });
      const request = {
        itemId: item.id,
        field: "value" as const,
        threadId,
        caller: { kind: "thread" as const, threadId },
      };
      const first = yield* vault.use(request),
        pending = yield* vault.use(request);
      expect(first.status).toBe("approval_required");
      if (first.status !== "approval_required" || pending.status !== "approval_required")
        throw new Error("Expected approval");
      expect(pending.approvalId).toBe(first.approvalId);
      yield* sql`UPDATE agent_approvals SET status = 'approved' WHERE id = ${first.approvalId}`;
      yield* vault.update({
        id: item.id,
        policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
      });
      const retry = yield* vault.use(request);
      if (retry.status !== "approval_required") throw new Error("Expected fresh approval");
      expect(retry.approvalId).not.toBe(first.approvalId);
      const rows = yield* sql`SELECT status FROM agent_approvals`;
      expect(rows.map((r) => r.status).sort()).toEqual(["approved", "pending"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("retains delivered revisions after deletion and refuses registry overflow", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "rotate",
        type: "note",
        secretFields: { value: "old-delivered-secret" },
      });
      const use = () => vault.use({ itemId: item.id, field: "value", caller: { kind: "human" } });
      yield* use();
      yield* vault.update({ id: item.id, secretFields: { value: "new-delivered-secret" } });
      yield* use();
      yield* vault.delete({ id: item.id });
      expect(yield* vault.scrubText("old-delivered-secret new-delivered-secret")).toBe(
        "[redacted vault secret] [redacted vault secret]",
      );
      const overflow = yield* vault
        .registerProcessSecrets(Array.from({ length: 20_000 }, (_, i) => `unique-delivered-${i}`))
        .pipe(Effect.result);
      expect(overflow._tag).toBe("Failure");
      expect(yield* vault.scrubText("old-delivered-secret")).toBe("[redacted vault secret]");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("retries a scrub reload invalidated while its old snapshot was in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const captured = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let pause = false;
        const intercepted = new Proxy(sql, {
          apply(target, receiver, args: Array<unknown>) {
            const query = Reflect.apply(target, receiver, args) as Statement.Statement<unknown>;
            if (!pause || !query.compile()[0].endsWith("FROM vault_items WHERE deleted_at IS NULL"))
              return query;
            pause = false;
            return query.pipe(
              Effect.tap(() =>
                Deferred.succeed(captured, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            );
          },
        });
        yield* Effect.gen(function* () {
          const vault = yield* Vault.Vault;
          yield* vault.create({ name: "old", type: "note", secretFields: { value: "old-secret" } });
          pause = true;
          const reload = yield* vault.scrubText("new-secret").pipe(Effect.forkChild);
          yield* Deferred.await(captured);
          yield* vault.create({ name: "new", type: "note", secretFields: { value: "new-secret" } });
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(reload)).toBe("[redacted vault secret]");
          expect(yield* vault.scrubText("new-secret")).toBe("[redacted vault secret]");
        }).pipe(
          Effect.provide(
            Vault.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted))),
          ),
        );
      }),
    ).pipe(Effect.provide(dependencies)),
  );

  it.effect("scrubs short passwords as whole tokens and retains delivered TOTP codes", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "short",
        type: "login",
        secretFields: {
          password: "p4ss",
          totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        },
      });
      expect(yield* vault.scrubText("p4ss xp4ss p4ss_word")).toBe(
        "[redacted vault secret] xp4ss p4ss_word",
      );
      const used = yield* vault.use({ itemId: item.id, field: "totp", caller: { kind: "human" } });
      if (used.status !== "allowed") throw new Error("Expected code");
      yield* TestClock.adjust(120_000);
      expect(yield* vault.scrubText(`code ${used.value} x${used.value}`)).toBe(
        `code [redacted vault secret] x${used.value}`,
      );
      const stream = yield* vault.makeOutputRedactor();
      const parts = [
        yield* stream("p4"),
        yield* stream("ss "),
        yield* stream(used.value.slice(0, 3)),
        yield* stream(used.value.slice(3)),
        yield* stream(" "),
        yield* stream("xp4ss ", true),
      ];
      expect(parts.join("")).toBe("[redacted vault secret] [redacted vault secret] xp4ss ");
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

const workspaceLayer = Workspace.layer.pipe(
  Layer.provideMerge(layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(AgentStore.AgentStore)({}),
      Layer.mock(Agents.AgentService)({}),
      Layer.mock(Work.WorkHandoffService)({}),
      Layer.mock(Schedules.ScheduledTaskService)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
  ),
);

describe("Vault default access", () => {
  const fillFrom = (itemId: Vault.VaultUseInput["itemId"], caller: ThreadId, domain: string) => ({
    itemId,
    field: "password" as const,
    caller: { kind: "thread" as const, threadId: caller },
    threadId: caller,
    domain,
    enforceAllowedDomains: true,
    action: "fill",
  });

  it.effect("fills on an allowed site without asking, from any chat or agent", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      // Saved the way request_secret's saveToVault stores a login: no policy given.
      const { item } = yield* vault.saveSecretValue({
        name: "ADSO member portal",
        type: "login",
        domains: ["theadso.my.site.com"],
        value: "adso-password-1",
      });
      expect(item.policy).toEqual({ mode: "allow", allowedAgentIds: [], allowedDomains: [] });
      expect(yield* vault.use(fillFrom(item.id, threadId, "theadso.my.site.com"))).toMatchObject({
        status: "allowed",
        value: "adso-password-1",
      });
      expect(
        yield* vault.use({
          ...fillFrom(item.id, threadId, "login.theadso.my.site.com"),
          caller: { kind: "agent", agentId: AgentId.make("agent:any") },
        }),
      ).toMatchObject({ status: "allowed" });
      expect(yield* sql`SELECT id FROM agent_approvals`).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks on a site outside the allowed ones; approving it keeps any agent allowed", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const workspace = yield* Workspace.AgentWorkspaceService;
      const { item } = yield* vault.create({
        name: "ADSO member portal",
        type: "login",
        allowedDomains: ["theadso.my.site.com"],
        secretFields: { username: "ops@example.test", password: "adso-password-2" },
      });
      const offSite = yield* vault.use(fillFrom(item.id, threadId, "phish.test"));
      expect(offSite.status).toBe("approval_required");
      if (offSite.status !== "approval_required" || !offSite.approvalId)
        throw new Error("Expected an approval");
      expect(offSite.message).toContain("not one of this item's allowed sites");
      yield* workspace.approve(offSite.approvalId);
      const approved = yield* vault.getMetadata(item.id);
      expect(approved.policy).toMatchObject({
        mode: "allow",
        allowedAgentIds: [],
        allowedDomains: [],
        approvedDomains: ["phish.test"],
      });
      expect((yield* vault.use(fillFrom(item.id, threadId, "phish.test"))).status).toBe("allowed");
      // Another chat may still fill on the item's own site without asking.
      expect(
        (yield* vault.use(fillFrom(item.id, ThreadId.make("thread:2"), "theadso.my.site.com")))
          .status,
      ).toBe("allowed");
    }).pipe(Effect.provide(workspaceLayer)),
  );

  it.effect("keeps an explicit Ask first and Block on the item's own site", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const ask = yield* vault.create({
        name: "Bank",
        type: "login",
        allowedDomains: ["bank.test"],
        policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
        secretFields: { password: "bank-password-1" },
      });
      expect((yield* vault.use(fillFrom(ask.item.id, threadId, "bank.test"))).status).toBe(
        "approval_required",
      );
      const blocked = yield* vault.create({
        name: "Payroll",
        type: "login",
        allowedDomains: ["payroll.test"],
        policy: { mode: "deny", allowedAgentIds: [], allowedDomains: [], ownerSet: true },
        secretFields: { password: "payroll-password-1" },
      });
      expect(yield* vault.use(fillFrom(blocked.item.id, threadId, "payroll.test"))).toMatchObject({
        status: "denied",
        reason: "policy",
      });
      // Block wins off-site too, and the owner can still use it.
      expect((yield* vault.use(fillFrom(blocked.item.id, threadId, "other.test"))).status).toBe(
        "denied",
      );
      expect(
        (yield* vault.use({
          itemId: blocked.item.id,
          field: "password",
          caller: { kind: "human" },
        })).status,
      ).toBe("allowed");
    }).pipe(Effect.provide(layer)),
  );
});

describe("Vault logins", () => {
  it.effect("keeps several logins for one site and asks which one when none is named", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const save = (username: string, password: string) =>
        vault.saveLogin({
          name: "GitHub",
          domain: "https://github.com/login",
          secretFields: { username, password },
          temporary: false,
          threadId,
          agentId: null,
        });
      const work = yield* save("octo-work", "work-password-1");
      const personal = yield* save("octo-home", "home-password-1");
      expect(work.item.name).toBe("GitHub");
      expect(personal.item.name).toBe("GitHub");
      const { sites } = yield* vault.list({});
      expect(sites).toEqual([
        {
          host: "github.com",
          siteName: "GitHub",
          logins: [
            {
              id: personal.item.id,
              label: "GitHub · octo-home",
              username: "octo-home",
              missingUsername: false,
            },
            {
              id: work.item.id,
              label: "GitHub · octo-work",
              username: "octo-work",
              missingUsername: false,
            },
          ],
        },
      ]);

      const fill = (selector: Partial<Vault.VaultUseInput>) =>
        vault.use({
          field: "password",
          caller: { kind: "thread", threadId },
          threadId,
          domain: "github.com",
          enforceAllowedDomains: true,
          ...selector,
        });
      const ambiguous = yield* fill({});
      expect(ambiguous.status).toBe("ambiguous");
      if (ambiguous.status === "ambiguous") {
        expect(
          ambiguous.candidates
            .map((candidate) => `${candidate.label}|${candidate.username}`)
            .toSorted(),
        ).toEqual(["GitHub · octo-home|octo-home", "GitHub · octo-work|octo-work"]);
        expect(JSON.stringify(ambiguous)).not.toContain("password-1");
      }
      // By name alone it is just as ambiguous; a label, username or id picks one.
      expect((yield* fill({ name: "GitHub" })).status).toBe("ambiguous");
      expect(yield* fill({ username: "octo-home" })).toMatchObject({
        status: "allowed",
        value: "home-password-1",
      });
      expect(yield* fill({ label: "GitHub · octo-work" })).toMatchObject({
        status: "allowed",
        value: "work-password-1",
      });
      expect(yield* fill({ itemId: work.item.id })).toMatchObject({ value: "work-password-1" });

      // Two logins may not share a label on one site.
      expect(
        yield* vault
          .create({
            name: "GitHub",
            type: "login",
            label: "GitHub · octo-work",
            allowedDomains: ["github.com"],
            secretFields: { password: "third-password" },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "label_conflict" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds the username to a password-only login through an update", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      // The 0.3.2 ADSO case: request_secret saved only the password.
      const { item } = yield* vault.saveSecretValue({
        name: "ADSO member portal",
        type: "login",
        domains: ["theadso.my.site.com"],
        value: "adso-password-3",
      });
      expect((yield* vault.list({})).sites[0]?.logins[0]).toMatchObject({
        username: null,
        missingUsername: true,
        label: "ADSO member portal",
      });
      const saved = yield* vault.saveLogin({
        name: "ADSO member portal",
        domain: "https://theadso.my.site.com/s/login",
        secretFields: { username: "ops@example.test" },
        updateItemId: item.id,
        temporary: false,
        threadId,
        agentId: null,
      });
      expect(saved.updated).toBe(true);
      expect(saved.item).toMatchObject({
        username: "ops@example.test",
        fields: ["username", "password"],
      });
      expect((yield* vault.list({})).sites[0]?.logins[0]).toEqual({
        id: item.id,
        label: "ADSO member portal · ops@example.test",
        username: "ops@example.test",
        missingUsername: false,
      });
      // The password survived the merge.
      expect(
        yield* vault.use({ itemId: item.id, field: "password", caller: { kind: "human" } }),
      ).toMatchObject({ value: "adso-password-3" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("upgrades logins saved before usernames were display text", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      const full = yield* vault.create({
        name: "Shop",
        type: "login",
        allowedDomains: ["shop.test"],
        secretFields: { username: "buyer@example.test", password: "shop-password-1" },
      });
      const passwordOnly = yield* vault.create({
        name: "Portal",
        type: "login",
        allowedDomains: ["portal.test"],
        secretFields: { password: "portal-password-1" },
      });
      // What an older build wrote: field names only, the username just encrypted.
      yield* sql`UPDATE vault_items SET metadata_json = '{"fields":["username","password"]}' WHERE id = ${full.item.id}`;
      expect((yield* vault.getMetadata(full.item.id)).username).toBeUndefined();

      expect(yield* vault.upgradeLogins).toEqual({ usernames: 1 });
      expect((yield* vault.getMetadata(full.item.id)).username).toBe("buyer@example.test");
      expect(yield* vault.getMetadata(passwordOnly.item.id)).toMatchObject({
        fields: ["password"],
      });
      const portal = (yield* vault.list({})).sites.find((site) => site.host === "portal.test");
      expect(portal?.logins[0]?.missingUsername).toBe(true);
      // Nothing left to upgrade, and the secret body is untouched.
      expect(yield* vault.upgradeLogins).toEqual({ usernames: 0 });
      expect(yield* vault.credentialRevision(full.item.id)).toBe(full.revision);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps passwords out of tool output, usage and stored metadata", () =>
    Effect.gen(function* () {
      const vault = yield* Vault.Vault;
      const sql = yield* SqlClient.SqlClient;
      const { item } = yield* vault.create({
        name: "Mail",
        type: "login",
        allowedDomains: ["mail.test"],
        secretFields: {
          username: "reader@example.test",
          password: "mail-password-1",
          totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        },
      });
      yield* vault.use({
        itemId: item.id,
        field: "username",
        caller: { kind: "thread", threadId },
        threadId,
        domain: "mail.test",
        enforceAllowedDomains: true,
      });
      yield* vault.use({
        itemId: item.id,
        field: "password",
        caller: { kind: "thread", threadId },
        threadId,
        domain: "mail.test",
        enforceAllowedDomains: true,
      });
      // The username stays readable in vault_list output; the password never does.
      expect(yield* vault.scrubText("reader@example.test mail-password-1")).toBe(
        "reader@example.test [redacted vault secret]",
      );
      const stored = JSON.stringify([
        yield* sql`SELECT metadata_json, policy_json, allowed_domains_json FROM vault_items`,
        yield* sql`SELECT * FROM vault_usage`,
        yield* vault.list({}),
      ]);
      expect(stored).not.toContain("mail-password-1");
      expect(stored).not.toContain("GEZDGNBVGY3TQOJQ");
    }).pipe(Effect.provide(layer)),
  );
});
