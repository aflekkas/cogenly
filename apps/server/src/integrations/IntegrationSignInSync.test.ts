import { loopbackHttpsPolicy } from "./https.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import { IntegrationName, VaultItemId, type IntegrationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";

import {
  Network,
  type VaultNode,
  expectAbsent,
  settle,
  share,
  startNode,
  storedText,
} from "../vault/vaultSync.testkit.ts";
import { LOCAL_GOOGLE_CLIENT_ITEM } from "../vault/vaultPortability.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import * as Integrations from "./Integrations.ts";
import * as IntegrationSyncPeers from "./IntegrationSyncPeers.ts";
import * as Tokens from "./IntegrationTokens.ts";
import { IntegrationEndpointPolicy } from "./RemoteEndpoint.ts";
import {
  COGENLY_ORIGIN,
  type MockAuthServer,
  consent,
  linearInput,
  startMockAuthServer,
} from "./oauthServer.testkit.ts";

/** A paired machine with the integrations gateway over its own vault. */
const startMachine = (network: Network, name: string) =>
  Effect.gen(function* () {
    const node = yield* startNode(network, name);
    const layer = Integrations.layer.pipe(
      // The mock servers listen on loopback, which production refuses.
      Layer.provide(Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy)),
      Layer.provide(Credentials.layer),
      Layer.provideMerge(Tokens.layer),
      Layer.provideMerge(IntegrationSyncPeers.layerFor(node.environmentId)),
      Layer.provide(FetchHttpClient.layer),
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
    };
  });
type Machine = Effect.Success<ReturnType<typeof startMachine>>;

/** Two machines that share their vaults with each other. */
const sharedPair = Effect.gen(function* () {
  const network = new Network();
  const hub = yield* startMachine(network, "Server");
  const spoke = yield* startMachine(network, "Laptop");
  network.pair(hub, spoke);
  yield* share(spoke, hub);
  yield* share(hub, spoke);
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

const signIn = (machine: Machine, id: IntegrationId, account: string) =>
  Effect.gen(function* () {
    const { authorizationUrl } = yield* machine.integrations.beginSignIn(id, {
      origin: COGENLY_ORIGIN,
    });
    return yield* machine.integrations.completeSignIn(yield* consent(authorizationUrl, account));
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
            oauthState?: { signedIn: boolean; tokenItemId?: string; refreshOwner?: string };
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

describe("web integration sign-ins across paired machines", () => {
  it.effect("a sign-in on the spoke signs the hub in once it syncs, and the hub refreshes it", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startMachine(network, "Server");
      const spoke = yield* startMachine(network, "Laptop");
      network.pair(hub, spoke);
      yield* share(spoke, hub);
      // The hub cannot read this vault yet, so the spoke refreshes its own sign-ins.
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
