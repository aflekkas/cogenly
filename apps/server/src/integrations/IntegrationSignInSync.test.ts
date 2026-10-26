import { loopbackHttpsPolicy } from "./https.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  IntegrationName,
  ProjectLabelId,
  VaultItemId,
  ProviderInstanceId,
  ThreadId,
  type IntegrationId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";

import {
  Network,
  type VaultNode,
  expectAbsent,
  settle,
  share,
  push,
  startNode,
  storedText,
} from "../vault/vaultSync.testkit.ts";
import { LOCAL_GOOGLE_CLIENT_ITEM } from "../vault/vaultPortability.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import * as Integrations from "./Integrations.ts";
import * as IntegrationSyncPeers from "./IntegrationSyncPeers.ts";
import * as Tokens from "./IntegrationTokens.ts";
import { IntegrationEndpointPolicy } from "./RemoteEndpoint.ts";
import * as DefinitionSync from "../sync/IntegrationSync.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { IntegrationsToolkit } from "../mcp/toolkits/integrations/tools.ts";
import * as Handlers from "../mcp/toolkits/integrations/handlers.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import {
  COGENLY_ORIGIN,
  type MockAuthServer,
  consent,
  linearInput,
  startMockAuthServer,
} from "./oauthServer.testkit.ts";

/** A paired machine with the integrations gateway over its own vault. */
const startGateway = (node: VaultNode) =>
  Effect.gen(function* () {
    const layer = Integrations.layer.pipe(
      // The mock servers listen on loopback, which production refuses.
      Layer.provide(Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy)),
      Layer.provide(Credentials.layer),
      Layer.provide(Credentials.secretsLayer),
      Layer.provideMerge(Tokens.layer),
      Layer.provideMerge(IntegrationSyncPeers.layerFor(node.environmentId)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(DefinitionSync.layerWithoutWatch),
      Layer.provide(Layer.succeedContext(node.context)),
    );
    const context = yield* Layer.build(layer);
    const peers = Context.get(context, IntegrationSyncPeers.IntegrationSyncPeers);
    yield* peers.bind(
      IntegrationSyncPeers.signInPeers({
        self: node.environmentId,
        machines: node.machines,
        vaultSync: node.sync,
        capture: node.capture,
      }),
    );
    return {
      ...node,
      integrations: Context.get(context, Integrations.Integrations),
      tokens: Context.get(context, Tokens.IntegrationTokens),
      peers,
      definitions: Context.get(context, DefinitionSync.IntegrationSync),
    };
  });
const startMachine = (network: Network, name: string) =>
  startNode(network, name).pipe(Effect.flatMap(startGateway));
type Machine = Effect.Success<ReturnType<typeof startMachine>>;

/** Two machines that share their vaults with each other. */
const sharedPair = Effect.gen(function* () {
  const network = new Network();
  const hub = yield* startMachine(network, "Server");
  const spoke = yield* startMachine(network, "Laptop");
  network.pair(hub, spoke);
  yield* settle(hub, [spoke]);
  return { network, hub, spoke };
});

/**
 * What definition sync does: the same integration, under the same id, on
 * another machine, without its sign-in.
 */
const copyDefinition = (from: VaultNode, to: Machine, id: IntegrationId) =>
  Effect.gen(function* () {
    const [row] = yield* from.sql<{
      name: string;
      payload_json: string;
      updated_at: string;
    }>`SELECT name, payload_json, updated_at FROM integrations WHERE id = ${id}`;
    const {
      oauthState: _,
      browserOrigin: _origin,
      ...definition
    } = JSON.parse(row!.payload_json) as Record<string, unknown>;
    yield* to.sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES (${id}, ${row!.name}, ${JSON.stringify(definition)}, NULL, ${row!.updated_at})`;
    yield* to.integrations.adoptSyncedSignIns(id);
  });

const addLinear = (machine: Machine, mock: MockAuthServer) =>
  machine.integrations
    .create(linearInput(mock, "linear"))
    .pipe(Effect.map(({ integration }) => integration));

const signIn = (machine: Machine, id: IntegrationId, account: string, origin = COGENLY_ORIGIN) =>
  Effect.gen(function* () {
    const { authorizationUrl } = yield* machine.integrations.beginSignIn(id, {
      origin,
    });
    return yield* machine.integrations.completeSignIn(
      yield* consent(authorizationUrl, account, origin),
    );
  });

const whoami = (machine: Machine) =>
  machine.integrations.callTool(IntegrationName.make("linear"), "whoami", {}, undefined);

const summaryOf = (machine: Machine, id: IntegrationId) =>
  machine.integrations
    .list()
    .pipe(
      Effect.map(({ integrations }) =>
        integrations.find((summary) => summary.integration.id === id),
      ),
    );

const oauthStateOf = (machine: Machine, id: IntegrationId) =>
  machine.sql<{
    payload_json: string;
  }>`SELECT payload_json FROM integrations WHERE id = ${id}`.pipe(
    Effect.map(
      ([row]) =>
        (
          JSON.parse(row!.payload_json) as {
            oauthState?: {
              signedIn: boolean;
              tokenItemId?: string;
              refreshOwner?: string;
              registration?: { clientId: string };
            };
          }
        ).oauthState,
    ),
  );

/** Waits, without polling, for the machine's integration list to say `status`. */
const awaitStatus = (machine: Machine, id: IntegrationId, status: string) =>
  machine.integrations.subscribe().pipe(
    Stream.takeUntil(({ integrations }) =>
      integrations.some((summary) => summary.integration.id === id && summary.status === status),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

const http = Effect.provide(FetchHttpClient.layer);
const encodeSignInAttachment = Schema.encodeEffect(Tokens.SignInAttachment);

describe("web integration sign-ins across paired machines", () => {
  it.effect(
    "a manually configured OAuth client signs in on its peer without setup and cannot adopt another client's old grant",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        mock.clients.set("manual-a", [`${COGENLY_ORIGIN}/oauth/integrations/callback`]);
        const { integration } = yield* spoke.integrations.create({
          ...linearInput(mock, "linear"),
          auth: { type: "oauth", clientId: "manual-a" },
        });
        yield* signIn(spoke, integration.id, "work");
        yield* settle(hub, [spoke]);
        yield* hub.definitions.reconcile;
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
        yield* whoami(hub);
        const itemId = (yield* oauthStateOf(hub, integration.id))!.tokenItemId!;
        const attachment = Option.getOrThrow(yield* hub.tokens.read(itemId)).attachment!;
        const { clientId: _, ...authorization } = attachment.authorization!;
        const legacyAttachment = yield* encodeSignInAttachment({ ...attachment, authorization });
        yield* hub.vault.setSyncAttachment(
          VaultItemId.make(itemId),
          legacyAttachment as Record<string, Schema.Json>,
        );
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
        yield* spoke.integrations.update({
          id: integration.id,
          auth: { type: "oauth", clientId: "manual-b" },
        });
        // Deliver the definition before projecting the vault removal. The old token
        // must not be adopted under the new client, even while it still exists here.
        yield* push(spoke, hub, false);
        yield* hub.definitions.reconcile;
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* summaryOf(hub, integration.id))?.status).toBe("needs_sign_in");
        expect((yield* oauthStateOf(hub, integration.id))?.signedIn).not.toBe(true);
      }).pipe(Effect.scoped, http),
  );

  it.effect.each(["claude", "codex"])(
    "%s's existing gateway sees a peer's new integration, credential, updates, disable and removal",
    (provider) =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const hubDefinitions = hub.definitions;
        const spokeDefinitions = spoke.definitions;
        const threadId = ThreadId.make(`thread:${provider}`);
        const instance = ProviderInstanceId.make(provider);
        const dependencies = Layer.mergeAll(
          Layer.succeed(Integrations.Integrations, hub.integrations),
          Layer.succeed(Invocation.McpInvocationContext, {
            environmentId: hub.environmentId,
            requestNamespace: `provider:${provider}`,
            thread: {
              threadId,
              providerSessionId: `session:${provider}`,
              providerInstanceId: instance,
            },
            client: undefined,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                ...liveThreadShell(threadId),
                providerInstanceId: instance,
                modelSelection: { instanceId: instance, model: "test" },
              }),
          }),
          Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
        );
        // Construct the provider-facing tool catalog once, before the integration exists.
        const toolkit = yield* IntegrationsToolkit.pipe(
          Effect.provide(
            Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
          ),
        );
        const list = () =>
          toolkit.handle("integrations_list", {}).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provide(dependencies),
            Effect.map((results) => results.at(-1)?.result),
          );
        const name = IntegrationName.make("live-source");
        const call = () =>
          toolkit.handle("integration_call", { name, tool: "whoami", arguments: {} }).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provide(dependencies),
            Effect.map((results) => results.at(-1)?.result),
          );
        expect(yield* list()).toEqual({ integrations: [] });
        expect(yield* call()).toMatchObject({ code: "invalid_request" });
        const mock = yield* startMockAuthServer;
        mock.accessTokens.set("api-key-shared-secret", "work");
        const { integration } = yield* spoke.integrations.create({
          name,
          displayName: "Live source",
          transport: "http",
          url: `${mock.base}/mcp`,
          headers: { authorization: "Bearer api-key-shared-secret" },
          accountLabel: "Work",
          scope: { type: "all" },
          hint: "",
        });
        const sync = Effect.gen(function* () {
          yield* spokeDefinitions.reconcile;
          yield* settle(hub, [spoke]);
          yield* hubDefinitions.reconcile;
          yield* hub.integrations.adoptSyncedSignIns();
        });
        yield* sync;
        expect(yield* list()).toMatchObject({
          integrations: [{ integration: { name, accountLabel: "Work" } }],
        });
        const tools = yield* toolkit
          .handle("integration_tools", { name })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        expect(tools.at(-1)?.result).toMatchObject({ tools: [{ name: "whoami" }] });
        expect(yield* call()).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("account=") }],
        });
        expect(mock.bearers.at(-1)).toBe("api-key-shared-secret");
        const second = yield* startMockAuthServer;
        second.accessTokens.set("api-key-shared-secret", "other");
        yield* spoke.integrations.update({
          id: integration.id,
          url: `${second.base}/mcp`,
          displayName: "Changed",
        });
        yield* sync;
        expect(yield* call()).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("account=") }],
        });
        expect(second.bearers.at(-1)).toBe("api-key-shared-secret");
        yield* spoke.integrations.update({ id: integration.id, enabled: false });
        yield* sync;
        expect(yield* call()).toMatchObject({ code: "invalid_request" });
        yield* spoke.integrations.update({ id: integration.id, enabled: true });
        yield* sync;
        expect(yield* call()).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("account=") }],
        });
        yield* spoke.integrations.remove(integration.id);
        yield* sync;
        expect(yield* call()).toMatchObject({ code: "invalid_request" });
        expect(JSON.stringify(yield* hub.state.get("integration", integration.id))).not.toContain(
          "api-key-shared-secret",
        );
        yield* hub.integrations.create({
          name,
          displayName: "Added here",
          transport: "http",
          url: `${mock.base}/mcp`,
          headers: { authorization: "Bearer api-key-shared-secret" },
          scope: { type: "all" },
          hint: "",
        });
        expect(yield* call()).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("account=work") }],
        });
      }).pipe(Effect.scoped, http),
  );

  it.effect("a sign-in on the spoke signs the hub in once it syncs, and the hub refreshes it", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startMachine(network, "Server");
      const spoke = yield* startMachine(network, "Laptop");
      network.pair(hub, spoke);
      // Pairing alone shares the vault and makes the hub the refresh owner.
      expect(yield* spoke.peers.defaultRefreshOwner).toBe(hub.environmentId);
      yield* hub.sync.setPeerSharing({ environmentId: spoke.environmentId, enabled: false });
      expect(yield* spoke.peers.defaultRefreshOwner).toBe(spoke.environmentId);
      yield* share(hub, spoke);
      expect(yield* spoke.peers.defaultRefreshOwner).toBe(hub.environmentId);
      expect(yield* hub.peers.defaultRefreshOwner).toBe(hub.environmentId);

      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* copyDefinition(spoke, hub, integration.id);
      expect((yield* summaryOf(hub, integration.id))?.status).toBe("needs_sign_in");

      // Adoption follows the vault's own change signal; nothing calls it here.
      const signedInOnHub = yield* awaitStatus(hub, integration.id, "unknown");
      yield* signIn(spoke, integration.id, "spawn");
      const spokeToken = mock.bearers.at(-1)!;
      yield* settle(hub, [spoke]);
      yield* Fiber.join(signedInOnHub);

      const state = yield* oauthStateOf(hub, integration.id);
      expect(state).toMatchObject({ signedIn: true, refreshOwner: hub.environmentId });
      const attachment = yield* hub.vault.getSyncAttachment(VaultItemId.make(state!.tokenItemId!));
      expect(attachment).toMatchObject({
        kind: "integration-oauth",
        v: 1,
        integrationId: integration.id,
        refreshOwner: hub.environmentId,
      });
      yield* whoami(hub);
      expect(mock.bearers.at(-1)).toBe(spokeToken);
      expect(mock.refreshes).toBe(0);
      expect((yield* hub.integrations.testConnection(integration.id)).status).toBe("connected");
    }).pipe(Effect.scoped, http),
  );

  it.effect("a definition that arrives after its sign-in adopts it when projected", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* signIn(spoke, integration.id, "spawn");
      yield* settle(hub, [spoke]);
      // copyDefinition calls adoptSyncedSignIns, as the projection of a synced definition does.
      yield* copyDefinition(spoke, hub, integration.id);
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
      yield* whoami(hub);
      expect(mock.refreshes).toBe(0);
    }).pipe(Effect.scoped, http),
  );

  it.effect(
    "only the refresh owner calls the token endpoint; the other machine waits, then uses its refresh",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(spoke, mock);
        yield* copyDefinition(spoke, hub, integration.id);
        yield* signIn(spoke, integration.id, "spawn");
        const first = mock.bearers.at(-1)!;
        yield* settle(hub, [spoke]);
        yield* hub.integrations.adoptSyncedSignIns();

        // Inside the refresh window the spoke still uses the token it has.
        yield* TestClock.adjust(Duration.minutes(59.5));
        yield* whoami(spoke);
        expect(mock.bearers.at(-1)).toBe(first);
        expect(mock.refreshes).toBe(0);

        // Expired on the spoke: it waits for the hub rather than refreshing.
        yield* TestClock.adjust(Duration.minutes(1));
        const waiting = yield* whoami(spoke).pipe(Effect.flip);
        expect(waiting.reason).toBe("sign_in_required");
        expect(Integrations.refreshWaitMessage(waiting)).toBe(
          "Waiting for Server to refresh this sign-in.",
        );
        expect(mock.refreshes).toBe(0);
        expect((yield* oauthStateOf(spoke, integration.id))?.signedIn).toBe(true);
        const summary = yield* summaryOf(spoke, integration.id);
        expect(summary?.status).not.toBe("needs_sign_in");
        expect(summary?.message).toBe("Waiting for Server to refresh this sign-in.");

        // The hub renews it on its own schedule; the new tokens reach the spoke.
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(1);
        yield* settle(hub, [spoke]);
        yield* whoami(spoke);
        const second = mock.bearers.at(-1)!;
        expect(second).not.toBe(first);
        yield* whoami(hub);
        expect(mock.bearers.at(-1)).toBe(second);
        expect(mock.refreshes).toBe(1);

        // A token the server refuses early: the spoke still never refreshes.
        mock.accessTokens.delete(second);
        const refused = yield* whoami(spoke).pipe(Effect.flip);
        expect(Integrations.refreshWaitMessage(refused)).toBeDefined();
        expect(mock.refreshes).toBe(1);
        expect((yield* oauthStateOf(spoke, integration.id))?.signedIn).toBe(true);
        // The owner refreshes on a refusal, as before.
        yield* whoami(hub);
        expect(mock.refreshes).toBe(2);
      }).pipe(Effect.scoped, http),
  );

  it.effect.each([false, true])(
    "short-lived shared tokens refresh halfway through with definition=%s",
    (hasDefinition) =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        mock.tokenLifetimeSeconds = 60;
        const integration = yield* addLinear(spoke, mock);
        if (hasDefinition) yield* copyDefinition(spoke, hub, integration.id);
        yield* signIn(spoke, integration.id, "spawn");
        yield* settle(hub, [spoke]);
        yield* hub.integrations.adoptSyncedSignIns();
        yield* TestClock.adjust(Duration.seconds(15));
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(0);
        yield* TestClock.adjust(Duration.seconds(16));
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(1);
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(1);
        yield* settle(hub, [spoke]);
        yield* whoami(spoke);
        expect(mock.refreshes).toBe(1);
      }).pipe(Effect.scoped, http),
  );

  it.effect.each(["endpoint", "project scope"] as const)(
    "a peer cannot restore a cleared grant after changing its %s",
    (change) =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(spoke, mock);
        yield* spoke.integrations.update({
          id: integration.id,
          scope: { type: "projects", labelIds: [ProjectLabelId.make("label:original")] },
        });
        yield* copyDefinition(spoke, hub, integration.id);
        yield* signIn(spoke, integration.id, "spawn");
        yield* settle(hub, [spoke]);
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
        // IntegrationSync drops the local grant when a peer changes its destination or widens scope.
        if (change === "endpoint")
          yield* hub.sql`UPDATE integrations SET payload_json = json_set(json_remove(payload_json, '$.oauthState'), '$.url', ${mock.base + "/other-mcp"}) WHERE id = ${integration.id}`;
        else
          yield* hub.sql`UPDATE integrations SET payload_json = json_set(json_remove(payload_json, '$.oauthState'), '$.scope', json('{"type":"all"}')) WHERE id = ${integration.id}`;
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* oauthStateOf(hub, integration.id))?.signedIn).not.toBe(true);
      }).pipe(Effect.scoped, http),
  );

  it.effect("a cached token gives way to a new revision of its item", () =>
    Effect.gen(function* () {
      const { spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* signIn(spoke, integration.id, "spawn");
      yield* whoami(spoke);
      // A write that is not a sync, so only the revision tells the cache.
      const replacement = "replacement-access-token-secretvalue";
      mock.accessTokens.set(replacement, "spawn");
      const itemId = (yield* oauthStateOf(spoke, integration.id))!.tokenItemId!;
      yield* spoke.vault.update({
        id: VaultItemId.make(itemId),
        secretFields: { value: replacement },
      });
      yield* whoami(spoke);
      expect(mock.bearers.at(-1)).toBe(replacement);
    }).pipe(Effect.scoped, http),
  );

  it.effect(
    "a refresh owner without the definition still renews a registered client's sign-in",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(spoke, mock);
        yield* signIn(spoke, integration.id, "spawn");
        const first = mock.bearers.at(-1)!;
        yield* settle(hub, [spoke]);
        yield* TestClock.adjust(Duration.minutes(59.5));
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(1);
        yield* settle(hub, [spoke]);
        yield* TestClock.adjust(Duration.minutes(1));
        yield* whoami(spoke);
        expect(mock.bearers.at(-1)).not.toBe(first);
        expect(mock.refreshes).toBe(1);
      }).pipe(Effect.scoped, http),
  );

  it.effect("signing out or a revoked grant on one machine needs sign-in on the other", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* copyDefinition(spoke, hub, integration.id);
      yield* signIn(spoke, integration.id, "spawn");
      yield* settle(hub, [spoke]);
      yield* hub.integrations.adoptSyncedSignIns();
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);

      // The hub owns the refresh and finds the grant revoked: both machines need sign-in.
      mock.revoked = true;
      yield* TestClock.adjust(Duration.minutes(59.5));
      const revokedOnSpoke = yield* awaitStatus(spoke, integration.id, "needs_sign_in");
      yield* hub.integrations.refreshSharedSignIns;
      expect((yield* summaryOf(hub, integration.id))?.status).toBe("needs_sign_in");
      yield* settle(hub, [spoke]);
      yield* Fiber.join(revokedOnSpoke);
      expect(mock.refreshes).toBe(1);

      // Signing in again on the spoke reaches the hub too.
      mock.revoked = false;
      yield* signIn(spoke, integration.id, "spawn");
      yield* settle(hub, [spoke]);
      yield* hub.integrations.adoptSyncedSignIns();
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);

      // A change that drops the tokens on the spoke deletes the shared item.
      const droppedOnHub = yield* awaitStatus(hub, integration.id, "needs_sign_in");
      yield* spoke.integrations.update({ id: integration.id, url: `${mock.base}/mcp?moved=1` });
      yield* settle(hub, [spoke]);
      yield* Fiber.join(droppedOnHub);
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(false);
    }).pipe(Effect.scoped, http),
  );

  it.effect("re-signing in with a new client updates an already signed-in refresh owner", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* copyDefinition(spoke, hub, integration.id);
      yield* signIn(spoke, integration.id, "old-account");
      yield* settle(hub, [spoke]);
      yield* hub.integrations.adoptSyncedSignIns();
      yield* whoami(hub);
      yield* signIn(spoke, integration.id, "new-account", "https://other.cogenly.example");
      yield* settle(hub, [spoke]);
      yield* hub.integrations.adoptSyncedSignIns();
      expect(mock.registrations).toBe(2);
      expect((yield* oauthStateOf(hub, integration.id))?.registration?.clientId).toBe("client-2");
      yield* TestClock.adjust(Duration.minutes(59.5));
      yield* hub.integrations.refreshSharedSignIns;
      expect(mock.refreshes).toBe(1);
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
      yield* settle(hub, [spoke]);
      yield* whoami(hub);
      yield* whoami(spoke);
      expect(mock.accessTokens.get(mock.bearers.at(-1)!)).toBe("new-account");
    }).pipe(Effect.scoped, http),
  );

  it.effect("repairs invalid_client when a re-sign-in lands during an old client's refresh", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* copyDefinition(spoke, hub, integration.id);
      yield* signIn(spoke, integration.id, "old-account");
      yield* settle(hub, [spoke]);
      yield* hub.integrations.adoptSyncedSignIns();
      const itemId = (yield* oauthStateOf(hub, integration.id))!.tokenItemId!;
      yield* TestClock.adjust(Duration.minutes(59.5));
      const gate = { entered: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() };
      mock.tokenGate = gate;
      const refreshing = yield* hub.integrations.refreshSharedSignIns.pipe(Effect.forkScoped);
      yield* Deferred.await(gate.entered);
      delete mock.tokenGate;
      yield* signIn(spoke, integration.id, "new-account", "https://other.cogenly.example");
      yield* settle(hub, [spoke]);
      const replacement = Option.getOrThrow(yield* hub.tokens.read(itemId));
      expect(replacement.attachment?.registration?.clientId).toBe("client-2");
      mock.clients.delete("client-1");
      yield* Deferred.succeed(gate.resume, undefined);
      yield* Fiber.join(refreshing);
      const current = yield* hub.tokens.read(itemId);
      expect(Option.getOrThrow(current)).toEqual(replacement);
      expect((yield* oauthStateOf(hub, integration.id))?.signedIn).toBe(true);
      yield* hub.integrations.adoptSyncedSignIns();
      yield* whoami(hub);
      expect(mock.accessTokens.get(mock.bearers.at(-1)!)).toBe("new-account");
    }).pipe(Effect.scoped, http),
  );

  it.effect(
    "upgrading a legacy web sign-in backfills its attachment before capture without moving refresh ownership",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const node = yield* startNode(network, "Laptop");
        const mock = yield* startMockAuthServer;
        const integration = yield* Effect.scoped(
          Effect.gen(function* () {
            const legacy = yield* startGateway(node);
            const integration = yield* addLinear(legacy, mock);
            yield* signIn(legacy, integration.id, "legacy-account");
            const itemId = (yield* oauthStateOf(legacy, integration.id))!.tokenItemId!;
            // The persisted shape before shared sign-ins: tokens plus local OAuth metadata.
            yield* node.sql`UPDATE vault_items SET sync_attachment_json = NULL WHERE id = ${itemId}`;
            yield* node.sql`UPDATE integrations SET payload_json = json_remove(payload_json, '$.oauthState.refreshOwner') WHERE id = ${integration.id}`;
            return integration;
          }),
        );
        const upgraded = yield* startGateway(node);
        const state = (yield* oauthStateOf(upgraded, integration.id))!;
        const itemId = VaultItemId.make(state.tokenItemId!);
        expect(yield* upgraded.vault.getSyncAttachment(itemId)).toMatchObject({
          kind: "integration-oauth",
          integrationId: integration.id,
          refreshOwner: upgraded.environmentId,
          registration: { clientId: "client-1" },
        });
        const revision = yield* upgraded.vault.credentialRevision(itemId);
        yield* upgraded.integrations.adoptSyncedSignIns();
        expect(yield* upgraded.vault.credentialRevision(itemId)).toBe(revision);
        const hub = yield* startMachine(network, "Server");
        yield* copyDefinition(upgraded, hub, integration.id);
        network.pair(hub, upgraded);
        yield* share(upgraded, hub);
        yield* share(hub, upgraded);
        yield* settle(hub, [upgraded]);
        yield* hub.integrations.adoptSyncedSignIns();
        expect((yield* oauthStateOf(hub, integration.id))?.refreshOwner).toBe(
          upgraded.environmentId,
        );
        yield* whoami(hub);
        yield* TestClock.adjust(Duration.minutes(59.5));
        yield* hub.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(0);
        yield* upgraded.integrations.refreshSharedSignIns;
        expect(mock.refreshes).toBe(1);
        yield* settle(hub, [upgraded]);
        yield* whoami(hub);
        expect(mock.accessTokens.get(mock.bearers.at(-1)!)).toBe("legacy-account");
      }).pipe(Effect.scoped, http),
  );

  it.effect("local integrations sign in per machine: no vault documents, no adoption", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const remote = yield* addLinear(spoke, mock);
      const [row] = yield* spoke.sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE id = ${remote.id}`;
      const localId = "integration:local-google" as IntegrationId;
      const definition = {
        ...(JSON.parse(row!.payload_json) as Record<string, unknown>),
        id: localId,
        name: "workspace",
        transport: "local",
        url: "https://accounts.google.com",
        headers: { authorization: "Bearer {{credential:Runner token.value}}" },
      };
      yield* spoke.sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES (${localId}, 'workspace', ${JSON.stringify(definition)}, NULL, '2026-01-01T00:00:00.000Z')`;
      const google = (yield* spoke.vault.create({
        name: LOCAL_GOOGLE_CLIENT_ITEM,
        type: "api_key",
        allowedDomains: ["accounts.google.com"],
        secretFields: { value: '{"web":{"client_secret":"google-client-secret"}}' },
      })).item;
      const runner = (yield* spoke.vault.create({
        name: "Runner token",
        type: "api_key",
        allowedDomains: [],
        secretFields: { value: "runner-secret-value" },
      })).item;
      for (const item of [google, runner]) {
        expect(item.portability).toBe("machine");
        expect(yield* spoke.state.get("vault", item.id)).toBeUndefined();
      }

      // A synced sign-in that names the local integration is never adopted for it.
      const { itemId } = yield* hub.tokens.write({
        itemId: undefined,
        name: "integration-oauth:local-google",
        label: "Workspace sign-in",
        host: "accounts.google.com",
        tokens: { accessToken: "forged-access-token-value", refreshToken: "forged-refresh" },
        attachment: {
          kind: "integration-oauth",
          v: 1,
          integrationId: localId,
          server: {
            resource: "https://accounts.google.com",
            issuer: "https://accounts.google.com",
            authorizationEndpoint: "https://accounts.google.com/o/oauth2/auth",
            tokenEndpoint: "https://oauth2.googleapis.com/token",
          },
          registration: { clientId: "client", authMethod: "none", redirectUris: [] },
          expiresAt: null,
          refreshOwner: hub.environmentId,
        },
      });
      yield* settle(hub, [spoke]);
      expect((yield* spoke.vault.getMetadata(VaultItemId.make(itemId))).name).toBe(
        "integration-oauth:local-google",
      );
      yield* spoke.integrations.adoptSyncedSignIns();
      expect(yield* oauthStateOf(spoke, localId)).toBeUndefined();
      expectAbsent(yield* storedText(hub), ["google-client-secret", "runner-secret-value"]);
    }).pipe(Effect.scoped, http),
  );

  it.effect("a sign-in whose item may not go to the integration's host is not adopted", () =>
    Effect.gen(function* () {
      const { hub, spoke } = yield* sharedPair;
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(spoke, mock);
      yield* signIn(spoke, integration.id, "spawn");
      const [row] = yield* spoke.sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE id = ${integration.id}`;
      const itemId = (JSON.parse(row!.payload_json) as { oauthState: { tokenItemId: string } })
        .oauthState.tokenItemId;
      yield* spoke.vault.update({
        id: VaultItemId.make(itemId),
        allowedDomains: ["elsewhere.example"],
      });
      yield* settle(hub, [spoke]);
      yield* copyDefinition(spoke, hub, integration.id);
      expect((yield* summaryOf(hub, integration.id))?.status).toBe("needs_sign_in");
    }).pipe(Effect.scoped, http),
  );

  it.effect(
    "no token or client secret reaches stored text, logs or spans on either machine",
    () => {
      const logs: Array<string> = [];
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const collector = Logger.make((options) => {
        let line = "";
        try {
          line = JSON.stringify(options.message);
        } catch {
          line = String(options.message);
        }
        logs.push(`${line} ${String(options.cause)}`);
      });
      return Effect.gen(function* () {
        const { hub, spoke } = yield* sharedPair;
        const mock = yield* startMockAuthServer;
        mock.confidential = true;
        const integration = yield* addLinear(spoke, mock);
        yield* copyDefinition(spoke, hub, integration.id);
        yield* signIn(spoke, integration.id, "spawn");
        yield* settle(hub, [spoke]);
        yield* hub.integrations.adoptSyncedSignIns();
        yield* whoami(hub);
        yield* TestClock.adjust(Duration.minutes(61));
        yield* whoami(spoke).pipe(Effect.flip);
        yield* hub.integrations.refreshSharedSignIns;
        yield* settle(hub, [spoke]);
        yield* whoami(spoke);
        expect(mock.refreshes).toBe(1);
        expect(mock.issued.filter((value) => value.startsWith("client-secret-"))).toHaveLength(1);
        expect(mock.issued.length).toBeGreaterThanOrEqual(5);

        for (const machine of [hub, spoke]) expectAbsent(yield* storedText(machine), mock.issued);
        expectAbsent(logs.join("\n"), mock.issued);
        const traced = spans
          .map((span) => `${span.name} ${JSON.stringify([...span.attributes.entries()])}`)
          .join("\n");
        expect(traced).toContain("Integrations.adoptSyncedSignIns");
        expectAbsent(traced, mock.issued);
      }).pipe(
        Effect.scoped,
        http,
        Effect.provide(Logger.layer([collector])),
        Effect.provideService(Tracer.Tracer, tracer),
      );
    },
  );
});
