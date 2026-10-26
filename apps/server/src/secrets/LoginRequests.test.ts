import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  VaultItemId,
  type OrchestrationV2LoginRequest,
} from "@cogenly/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AgentStore from "../agents/AgentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import * as InlineCardNotifications from "../orchestration-v2/InlineCardNotifications.ts";
import * as SecretRequests from "./SecretRequests.ts";
import * as LoginRequests from "./LoginRequests.ts";

const threadId = ThreadId.make("thread:login");
const turnItemId = TurnItemId.make("turn-item:login-request:1");
const PASSWORD = "fake-pass-Hunter2!";
const USERNAME = "ada@example.test";

const memoryStore = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!values.has(name)) values.set(name, new Uint8Array(bytes).fill(7));
        return values.get(name)!;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  } as ServerSecretStore.ServerSecretStore["Service"]);
};

/**
 * One thread with a live run and a pending sign-in card. Every command the
 * service dispatches is kept as JSON: that is what becomes events.
 */
const fixture = (
  login: OrchestrationV2LoginRequest | undefined,
  runStatus = "running",
  extra: Record<string, unknown> = {},
) => {
  const commands: Array<string> = [];
  const notifications: string[] = [];
  const card = {
    type: "secret_request",
    id: turnItemId,
    threadId,
    runId: RunId.make("run:1"),
    nodeId: NodeId.make("node:1"),
    status: "waiting",
    label: "Sign in to GitHub",
    reason: "Open the repository settings.",
    secretStatus: "pending",
    login,
    ...extra,
  };
  const records = {
    thread: { projectId: "project:1" },
    runs: [{ id: RunId.make("run:1"), status: runStatus }],
    turnItems: [card] as Array<Record<string, unknown>>,
  };
  const threads = Layer.mock(Threads.ThreadManagementService)({
    getThreadRecords: () => Effect.succeed(records as never),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(JSON.stringify(command));
        if (command.type === "secret_request.record") {
          records.turnItems = [
            {
              ...card,
              secretStatus: command.secretStatus,
              login: command.login ?? login,
              secretVault: command.secretVault,
            },
          ];
        }
        return { sequence: 0, storedEvents: [] } as never;
      }),
  });
  const base = Layer.mergeAll(
    Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
    NodeCrypto.layer,
    memoryStore(),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
    }),
  );
  const vault = Vault.layer.pipe(Layer.provideMerge(base));
  const layer = Layer.mergeAll(LoginRequests.layer, SecretRequests.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        vault,
        threads,
        Layer.succeed(InlineCardNotifications.InlineCardNotifications, {
          answered: (input) =>
            Effect.sync(() => {
              notifications.push(input.summary);
            }),
        }),
        Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
      ),
    ),
  );
  const card_ = () =>
    records.turnItems[0] as { secretStatus: string; login: OrchestrationV2LoginRequest };
  return { commands, notifications, layer, card: card_ };
};

const github: OrchestrationV2LoginRequest = {
  origin: "https://github.com",
  siteName: "GitHub",
  fields: ["username", "password"],
};

const fill = (vault: Vault.Vault["Service"], itemId: string, field: "username" | "password") =>
  vault.use({
    itemId: VaultItemId.make(itemId),
    field,
    caller: { kind: "thread", threadId },
    threadId,
    domain: "github.com",
    action: "fill",
    enforceAllowedDomains: true,
  });

describe("LoginRequests", () => {
  it.effect("saves a login to the vault that agents can fill on that site without asking", () => {
    const { commands, layer, card } = fixture(github);
    return Effect.gen(function* () {
      const logins = yield* LoginRequests.LoginRequests;
      const vault = yield* Vault.Vault;
      yield* logins.answer({
        threadId,
        turnItemId,
        answer: { type: "save", username: ` ${USERNAME} `, password: PASSWORD, keep: true },
      });

      expect(card().secretStatus).toBe("saved");
      const itemId = card().login.savedItemId!;
      expect(card().login).toMatchObject({ savedItemName: "GitHub", kept: true });
      const { items } = yield* vault.list({});
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "login",
        allowedDomains: ["github.com"],
        policy: { mode: "allow", allowedDomains: ["github.com"] },
        fields: ["username", "password"],
        portability: "shared",
      });

      // A later fill on that site needs no approval; elsewhere it is refused.
      expect(yield* fill(vault, itemId, "password")).toMatchObject({
        status: "allowed",
        value: PASSWORD,
      });
      expect(yield* fill(vault, itemId, "username")).toMatchObject({ value: USERNAME });
      const elsewhere = yield* vault.use({
        itemId: VaultItemId.make(itemId),
        field: "password",
        caller: { kind: "thread", threadId },
        domain: "evil.example",
        enforceAllowedDomains: true,
      });
      expect(elsewhere.status).toBe("denied");

      const { usage } = yield* vault.listUsage({ itemId: VaultItemId.make(itemId) });
      expect(usage).toContainEqual(
        expect.objectContaining({
          action: "saved_from_request",
          threadId,
          domain: "github.com",
          outcome: "saved",
        }),
      );

      // The values never become part of a command, so never of an event.
      expect(commands.join("\n")).not.toContain(PASSWORD);
      expect(commands.join("\n")).not.toContain(USERNAME);
    }).pipe(Effect.provide(layer));
  });

  it.effect("declining closes the card and stores nothing", () => {
    const { layer, card } = fixture(github);
    return Effect.gen(function* () {
      const logins = yield* LoginRequests.LoginRequests;
      const vault = yield* Vault.Vault;
      yield* logins.answer({ threadId, turnItemId, answer: { type: "decline" } });
      expect(card().secretStatus).toBe("declined");
      expect(card().login.origin).toBe("https://github.com");
      expect((yield* vault.list({})).items).toEqual([]);
      // Answered once: a late save is refused.
      const late = yield* logins
        .answer({ threadId, turnItemId, answer: { type: "save", password: PASSWORD, keep: true } })
        .pipe(Effect.flip);
      expect(late.reason).toBe("already_answered");
    }).pipe(Effect.provide(layer));
  });

  it.effect("updating an existing login replaces its secrets and keeps the owner's policy", () => {
    const { commands, layer, card } = fixture({
      ...github,
      fields: ["password"],
      updateItemId: "pending",
    });
    return Effect.gen(function* () {
      const logins = yield* LoginRequests.LoginRequests;
      const vault = yield* Vault.Vault;
      const { item } = yield* vault.create({
        name: "Work GitHub" as never,
        type: "login",
        scopeProjectId: null,
        allowedDomains: ["github.com"] as never,
        policy: { mode: "allow", allowedAgentIds: [], allowedDomains: [] },
        secretFields: { username: USERNAME, password: "old-fake-pass" },
      });
      const current = card();
      current.login = { ...current.login, updateItemId: item.id, updateItemName: item.name };

      yield* logins.answer({
        threadId,
        turnItemId,
        answer: { type: "save", password: PASSWORD, keep: false },
      });

      expect(card().login).toMatchObject({ savedItemId: item.id, kept: true });
      const { items } = yield* vault.list({});
      expect(items).toHaveLength(1);
      expect(items[0]!.policy).toEqual(item.policy);
      expect(yield* fill(vault, item.id, "password")).toMatchObject({ value: PASSWORD });
      // Fields the card did not ask for are left alone.
      expect(yield* fill(vault, item.id, "username")).toMatchObject({ value: USERNAME });
      const { usage } = yield* vault.listUsage({ itemId: item.id });
      expect(usage.map((entry) => entry.action)).toContain("updated_from_request");
      expect(commands.join("\n")).not.toContain(PASSWORD);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a login the user chose not to keep stays on this machine", () => {
    const { layer, card } = fixture(github);
    return Effect.gen(function* () {
      const logins = yield* LoginRequests.LoginRequests;
      const vault = yield* Vault.Vault;
      yield* logins.answer({
        threadId,
        turnItemId,
        answer: { type: "save", password: PASSWORD, keep: false },
      });
      expect(card().login.kept).toBe(false);
      const { items } = yield* vault.list({});
      expect(items[0]).toMatchObject({ portability: "machine" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an empty save but delivers an answer after the agent stopped", () =>
    Effect.gen(function* () {
      const empty = fixture(github);
      const emptyError = yield* LoginRequests.LoginRequests.pipe(
        Effect.flatMap((logins) =>
          logins.answer({
            threadId,
            turnItemId,
            // Only fields the card asked for count; this one asked for none of these.
            answer: { type: "save", totpSecret: "JBSWY3DPEHPK3PXP", password: "  ", keep: true },
          }),
        ),
        Effect.flip,
        Effect.provide(empty.layer),
      );
      expect(emptyError.reason).toBe("login_empty");

      const stopped = fixture(github, "completed");
      yield* LoginRequests.LoginRequests.pipe(
        Effect.flatMap((logins) =>
          logins.answer({
            threadId,
            turnItemId,
            answer: { type: "save", password: PASSWORD, keep: true },
          }),
        ),
        Effect.provide(stopped.layer),
      );
      expect(stopped.card().secretStatus).toBe("saved");
      expect(stopped.notifications).toHaveLength(1);
      expect(stopped.notifications[0]).toContain("Login saved:");
    }),
  );
});

it.effect("a late secret answer goes directly to the vault and emits metadata only", () => {
  const box = fixture(undefined, "completed", {
    secretVault: { name: "late-key", type: "api_key", domains: ["example.test"] },
  });
  return Effect.gen(function* () {
    const requests = yield* SecretRequests.SecretRequests;
    const vault = yield* Vault.Vault;
    const fakeSecret = "GOCSPX-fakeOnly_0123456789abCDef";
    yield* requests.answer({ threadId, turnItemId, answer: { type: "save", secret: fakeSecret } });
    const item = (yield* vault.list({})).items.find((item) => item.name === "late-key")!;
    expect(item).toBeDefined();
    const saved = yield* vault.readCredential(item.id);
    expect(saved.secretFields.value === fakeSecret).toBe(true);
    expect(box.commands.join("").includes(fakeSecret)).toBe(false);
    expect(box.notifications.join("").includes(fakeSecret)).toBe(false);
    expect(box.card().secretStatus).toBe("saved");
    expect(box.notifications).toHaveLength(1);
  }).pipe(Effect.provide(box.layer));
});

it.effect("a declined private request notifies the thread without storing a value", () => {
  const box = fixture(undefined, "completed");
  return Effect.gen(function* () {
    const requests = yield* SecretRequests.SecretRequests;
    yield* requests.answer({ threadId, turnItemId, answer: { type: "decline" } });
    expect(box.notifications[0]).toContain("declined");
    expect((yield* (yield* Vault.Vault).list({})).items).toHaveLength(0);
  }).pipe(Effect.provide(box.layer));
});
