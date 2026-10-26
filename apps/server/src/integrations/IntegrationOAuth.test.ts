import { loopbackHttpsPolicy } from "./https.testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto as EffectNodeCrypto } from "@effect/platform-node";
import { EnvironmentId, IntegrationName, ThreadId, type IntegrationId } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { StoredIntegration } from "./StoredIntegration.ts";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import { CALLBACK_PATH } from "./IntegrationOAuth.ts";
import * as InlineCardEvents from "../orchestration-v2/InlineCardEvents.ts";
import * as Queue from "effect/Queue";
import * as Integrations from "./Integrations.ts";
import * as IntegrationOAuthHttp from "./integrationOAuthHttp.ts";
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

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

/** The gateway over the real vault, as in production. */
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredIntegration));

const gatewayLayer = (
  wrapTokens?: (tokens: Tokens.IntegrationTokens["Service"]) => Tokens.IntegrationTokens["Service"],
) => {
  const stored = new Map<string, Uint8Array>();
  return Integrations.layer.pipe(
    Layer.provideMerge(InlineCardEvents.layer),
    // The mock servers listen on loopback, which production refuses.
    Layer.provide(Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy)),
    Layer.provideMerge(Credentials.layer),
    Layer.provide(Credentials.secretsLayer),
    Layer.provideMerge(
      Layer.effect(
        Tokens.IntegrationTokens,
        Effect.map(Tokens.IntegrationTokens, (tokens) => wrapTokens?.(tokens) ?? tokens),
      ).pipe(Layer.provide(Tokens.layer)),
    ),
    Layer.provideMerge(IntegrationSyncPeers.layerFor("env:test")),
    Layer.provideMerge(Vault.layer),
    Layer.provide(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromUndefinedOr(stored.get(name))),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
      }),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(EffectNodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );
};

const addLinear = (mock: MockAuthServer, name: string, accountLabel?: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integration } = yield* service.create(linearInput(mock, name, accountLabel));
    return integration;
  });

const signIn = (id: IntegrationId, account: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { authorizationUrl } = yield* service.beginSignIn(id, { origin: COGENLY_ORIGIN });
    return yield* service.completeSignIn(yield* consent(authorizationUrl, account));
  });

const statusOf = (id: IntegrationId) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integrations } = yield* service.list();
    return integrations.find((summary) => summary.integration.id === id);
  });

const whoami = (name: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const result = yield* service.callTool(IntegrationName.make(name), "whoami", {}, undefined);
    return JSON.stringify(result.content);
  });

describe("Integration OAuth sign-in", () => {
  it.effect(
    "never sends an approved resource client secret to a discovered foreign auth server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const resource = yield* startMockAuthServer;
          const attacker = yield* startMockAuthServer;
          resource.authorizationServerBase = attacker.base;
          const service = yield* Integrations.Integrations;
          const vault = yield* Vault.Vault;
          yield* vault.create({
            name: "resource-client",
            type: "api_key",
            allowedDomains: ["127.0.0.1"],
            secretFields: { value: "PRIVATE-CLIENT-SECRET" },
          });
          const { integration } = yield* service.create(
            {
              ...linearInput(resource, "resource"),
              auth: {
                type: "oauth",
                clientId: "manual-client",
                clientSecret: "{{credential:resource-client.value}}",
              },
            },
            { approveCredentials: true },
          );
          const link = yield* service
            .beginSignIn(integration.id, { origin: COGENLY_ORIGIN })
            .pipe(Effect.result);
          // Exercise the exchange too if discovery incorrectly permits the foreign server.
          if (link._tag === "Success") {
            yield* service
              .completeSignIn({
                state: new URL(link.success.authorizationUrl).searchParams.get("state")!,
                code: "attacker-code",
                error: undefined,
                iss: undefined,
              })
              .pipe(Effect.result);
          }
          expect(attacker.tokenRequests).toEqual([]);
          expect(link).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect.each(["authorizationEndpoint", "tokenEndpoint"] as const)(
    "rejects an unapproved discovery change to %s, including a path on the same origin",
    (endpoint) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          const integration = yield* addLinear(mock, "linear");
          const service = yield* Integrations.Integrations;
          yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
          mock[endpoint] = `${mock.base}/changed`;
          expect(
            yield* service
              .beginSignIn(integration.id, { origin: COGENLY_ORIGIN })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
          expect(mock.tokenRequests).toEqual([]);
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("requires the vault domain even for an explicitly reviewed OAuth server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const service = yield* Integrations.Integrations;
        const vault = yield* Vault.Vault;
        yield* vault.create({
          name: "restricted-client",
          type: "api_key",
          allowedDomains: ["resource.example"],
          secretFields: { value: "RESTRICTED-CLIENT-SECRET" },
        });
        const { integration } = yield* service.create(
          {
            ...linearInput(mock, "manual"),
            auth: {
              type: "oauth",
              clientId: "manual-client",
              clientSecret: "{{credential:restricted-client.value}}",
              server: {
                issuer: `${mock.base}/auth`,
                authorizationEndpoint: `${mock.base}/auth/authorize`,
                tokenEndpoint: `${mock.base}/auth/token`,
              },
            },
          },
          { approveCredentials: true },
        );
        const link = yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
        expect(
          yield* service
            .completeSignIn({
              state: new URL(link.authorizationUrl).searchParams.get("state")!,
              code: "code",
              error: undefined,
              iss: undefined,
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "credential_not_allowed" } });
        expect(mock.tokenRequests).toEqual([]);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect(
    "requires owner approval for explicit OAuth server overrides, even before a grant exists",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          const service = yield* Integrations.Integrations;
          const integration = yield* addLinear(mock, "linear");
          yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
          const auth = {
            type: "oauth" as const,
            server: {
              issuer: `${mock.base}/auth`,
              authorizationEndpoint: `${mock.base}/changed`,
              tokenEndpoint: `${mock.base}/auth/token`,
            },
          };
          expect(
            yield* service
              .update({ id: integration.id, auth }, { fromAgent: true })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
          expect(
            yield* service
              .create({ ...linearInput(mock, "other"), auth }, { fromAgent: true })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "approval_required" } });
          const approved = yield* service.update(
            { id: integration.id, auth },
            { approveCredentials: true },
          );
          expect(approved.integration.auth?.server).toEqual(auth.server);
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("agent sign-in requests cannot evict an owner's pending callback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        const service = yield* Integrations.Integrations;
        const owner = yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
        const callback = yield* consent(owner.authorizationUrl, "owner");
        for (let i = 0; i < 65; i++)
          yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN, fromAgent: true });
        yield* service.completeSignIn(callback);
        expect(yield* whoami("linear")).toContain("account=owner");
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("refuses omitted PKCE metadata before registering a client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        mock.omitPkce = true;
        const integration = yield* addLinear(mock, "linear");
        const service = yield* Integrations.Integrations;
        expect(
          yield* service
            .beginSignIn(integration.id, { origin: COGENLY_ORIGIN })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(mock.registrations).toBe(0);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect.each(["missing", "normalized"] as const)(
    "rejects %s response issuer when the server advertises iss",
    (response) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          mock.requireIssuer = true;
          const integration = yield* addLinear(mock, "linear");
          const service = yield* Integrations.Integrations;
          const link = yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
          const callback = yield* consent(link.authorizationUrl, "owner");
          expect(
            yield* service
              .completeSignIn({
                ...callback,
                iss: response === "missing" ? undefined : `${callback.iss}/`,
              })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
          expect(mock.accessTokens.size).toBe(0);
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect.each(["auth", "url", "client"] as const)(
    "requires owner approval before an agent drops a grant through %s",
    (field) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          const integration = yield* addLinear(mock, "linear");
          yield* signIn(integration.id, "owner");
          const service = yield* Integrations.Integrations;
          const change =
            field === "auth"
              ? { auth: null }
              : field === "url"
                ? { url: `${mock.base}/changed` }
                : { auth: { type: "oauth" as const, clientId: "attacker" } };
          const result = yield* service
            .update({ id: integration.id, ...change }, { holdStoredSecrets: true })
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "approval_required" },
          });
          expect(yield* whoami("linear")).toContain("account=owner");
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("agents can request renewed consent, and sign-in records agent-link provenance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        const service = yield* Integrations.Integrations;
        const first = yield* service.beginSignIn(integration.id, {
          origin: COGENLY_ORIGIN,
          fromAgent: true,
        });
        yield* service.completeSignIn(yield* consent(first.authorizationUrl, "owner"));
        expect((yield* statusOf(integration.id))?.integration.provenance?.signedInViaAgent).toBe(
          true,
        );
        mock.revoked = true;
        mock.accessTokens.clear();
        yield* whoami("linear").pipe(Effect.result);
        expect(
          yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN, fromAgent: true }),
        ).toHaveProperty("authorizationUrl");
        expect(
          yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN }),
        ).toHaveProperty("authorizationUrl");
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("retains each account's browser origin across service restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        yield* signIn(integration.id, "spawn");
        const restarted = Context.get(
          yield* Layer.build(
            Integrations.layerWith({}).pipe(
              Layer.provide(Layer.succeed(IntegrationEndpointPolicy, loopbackHttpsPolicy)),
            ),
          ),
          Integrations.Integrations,
        );
        expect(
          yield* restarted.beginSignIn(integration.id, {
            origin: "http://localhost:3000",
            fromAgent: true,
          }),
        ).toHaveProperty("authorizationUrl");
        const link = yield* restarted.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
        expect(link.redirectUri).toBe(`${COGENLY_ORIGIN}${CALLBACK_PATH}`);
        expect(JSON.stringify(yield* restarted.list())).not.toContain("browserOrigin");
        const other = yield* addLinear(mock, "other");
        const missing = yield* restarted
          .beginSignIn(other.id, { origin: "http://localhost:3000", fromAgent: true })
          .pipe(Effect.result);
        expect(missing._tag).toBe("Failure");
        if (missing._tag === "Failure") expect(missing.failure.cause).toContain("Settings");
        const explicit = yield* restarted.beginSignIn(other.id, {
          origin: "http://localhost:3000",
          fromAgent: true,
          callbackOrigin: "https://vps.example",
        });
        expect(explicit.redirectUri).toBe(`https://vps.example${CALLBACK_PATH}`);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect.each(["edit", "client", "version", "remove"] as const)(
    "discards a code exchange completed after %s",
    (mutation) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          const integration = yield* addLinear(mock, "linear");
          const service = yield* Integrations.Integrations;
          const link = yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN });
          const callback = yield* consent(link.authorizationUrl, "spawn");
          const gate = {
            entered: yield* Deferred.make<void>(),
            resume: yield* Deferred.make<void>(),
          };
          mock.tokenGate = gate;
          const completion = yield* service
            .completeSignIn(callback)
            .pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(gate.entered);
          if (mutation === "edit")
            yield* service.update({ id: integration.id, url: `${mock.base}/changed` });
          else if (mutation === "client")
            yield* service.update({
              id: integration.id,
              auth: { type: "oauth", clientId: "changed" },
            });
          else if (mutation === "version") {
            yield* TestClock.adjust("1 second");
            yield* service.update({ id: integration.id, displayName: "Changed" });
          } else yield* service.remove(integration.id);
          yield* Deferred.succeed(gate.resume, undefined);
          expect((yield* Fiber.join(completion))._tag).toBe("Failure");
          const vault = yield* Vault.Vault;
          expect(
            (yield* vault.list({})).items.filter((item) =>
              item.name.startsWith("integration-oauth:"),
            ),
          ).toHaveLength(0);
          expect(mock.bearers.filter((bearer) => bearer !== undefined)).toHaveLength(0);
          if (mutation === "edit")
            expect((yield* statusOf(integration.id))?.status).toBe("needs_sign_in");
        }),
      ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect.each([
    ["refresh", "url"],
    ["refresh", "delete"],
    ["sign_in", "url"],
    ["sign_in", "delete"],
    ["refresh", "cosmetic"],
    ["refresh", "disable"],
    ["sign_in", "cosmetic"],
    ["sign_in", "disable"],
  ] as const)("grant commit respects a peer edit: %s", ([operation, mutation]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let blocked = false;
        yield* Effect.gen(function* () {
          yield* runMigrations();
          const mock = yield* startMockAuthServer;
          const integration = yield* addLinear(mock, "linear");
          const service = yield* Integrations.Integrations;
          if (operation === "refresh") {
            yield* signIn(integration.id, "owner");
            yield* TestClock.adjust("3590 seconds");
          }
          const link =
            operation === "sign_in"
              ? yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN })
              : undefined;
          const callback = link ? yield* consent(link.authorizationUrl, "owner") : undefined;
          blocked = true;
          const pending = callback
            ? service.completeSignIn(callback).pipe(Effect.asVoid)
            : service.callTool(integration.name, "whoami", {}, null).pipe(Effect.asVoid);
          const completion = yield* pending.pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(entered);
          // Shared definitions materialize directly in SQL, outside the local
          // OAuth lock. Change exactly that persisted boundary while vault I/O
          // is in flight, after the service has validated its old definition.
          const sql = yield* SqlClient.SqlClient;
          const at = "2026-01-02T00:00:00.000Z";
          if (mutation === "url")
            yield* sql`UPDATE integrations SET payload_json=json_remove(json_set(payload_json,'$.url','https://changed.example/mcp','$.updatedAt',${at}),'$.oauthState'),updated_at=${at} WHERE id=${integration.id}`;
          else if (mutation === "cosmetic")
            yield* sql`UPDATE integrations SET payload_json=json_set(payload_json,'$.displayName','Renamed by peer','$.updatedAt',${at}),updated_at=${at} WHERE id=${integration.id}`;
          else if (mutation === "disable")
            yield* sql`UPDATE integrations SET payload_json=json_set(payload_json,'$.enabled',json('false'),'$.updatedAt',${at}),updated_at=${at} WHERE id=${integration.id}`;
          else
            yield* sql`UPDATE integrations SET payload_json=json_remove(json_set(payload_json,'$.deletedAt',${at},'$.updatedAt',${at}),'$.oauthState'),deleted_at=${at},updated_at=${at} WHERE id=${integration.id}`;
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(completion);
          const rejected = mutation === "url" || mutation === "delete";
          expect(result._tag).toBe(
            rejected || (mutation === "disable" && operation === "refresh") ? "Failure" : "Success",
          );
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM integrations WHERE id=${integration.id}`;
          const stored = yield* decodeStored(rows[0]!.payload_json);
          if (rejected) expect(stored.oauthState).toBeUndefined();
          else expect(stored.oauthState?.signedIn).toBe(true);
          expect(stored.url).toBe(
            mutation === "url" ? "https://changed.example/mcp" : integration.url,
          );
          expect((yield* (yield* Vault.Vault).list({})).items).toHaveLength(rejected ? 0 : 1);
          if (!rejected) {
            blocked = false;
            if (mutation === "disable")
              yield* service.update({ id: integration.id, enabled: true });
            const call = yield* service.callTool(integration.name, "whoami", {}, null);
            expect(call.isError).not.toBe(true);
          }
        }).pipe(
          Effect.provide(
            gatewayLayer((tokens) => ({
              ...tokens,
              write: (input) =>
                Effect.gen(function* () {
                  if (blocked) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(resume);
                  }
                  return yield* tokens.write(input);
                }),
            })),
          ),
        );
      }),
    ),
  );

  it.effect("discovers, registers, exchanges a PKCE code and calls with the token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        expect((yield* statusOf(integration.id))?.status).toBe("needs_sign_in");

        const service = yield* Integrations.Integrations;
        const { authorizationUrl, redirectUri } = yield* service.beginSignIn(integration.id, {
          origin: COGENLY_ORIGIN,
        });
        expect(redirectUri).toBe(`${COGENLY_ORIGIN}${CALLBACK_PATH}`);
        const link = new URL(authorizationUrl);
        expect(link.origin + link.pathname).toBe(`${mock.base}/auth/authorize`);
        expect(link.searchParams.get("resource")).toBe(`${mock.base}/mcp`);
        expect(link.searchParams.get("code_challenge_method")).toBe("S256");
        expect(link.searchParams.get("scope")).toBe("read write");
        expect(mock.registrations).toBe(1);

        yield* service.completeSignIn(yield* consent(authorizationUrl, "spawn"));
        const summary = yield* statusOf(integration.id);
        expect(summary?.status).toBe("connected");
        expect(summary?.toolCount).toBe(1);
        expect(yield* whoami("linear")).toContain("account=spawn");
        expect(mock.bearers.at(-1)).toMatch(/^access-spawn-/);

        // The tokens are a vault item tied to this account, one field per secret.
        const vault = yield* Vault.Vault;
        const { items } = yield* vault.list({});
        expect(items).toHaveLength(1);
        expect(items[0]?.name).toBe(
          `integration-oauth:${integration.id.replace(/^integration:/, "")}`,
        );
        expect([...(items[0]?.fields ?? [])].toSorted()).toEqual(["password", "value"]);

        // Signing in again reuses the registered client.
        yield* signIn(integration.id, "spawn");
        expect(mock.registrations).toBe(1);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("refreshes before expiry, and refreshes and retries once on a 401", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        yield* signIn(integration.id, "spawn");
        const first = mock.bearers.at(-1)!;

        // Near expiry: the next call refreshes first, then uses the new token.
        yield* TestClock.adjust(Duration.minutes(59.5));
        expect(yield* whoami("linear")).toContain("account=spawn");
        expect(mock.refreshes).toBe(1);
        const second = mock.bearers.at(-1)!;
        expect(second).not.toBe(first);

        // The server drops the token early: one 401, one refresh, one retry.
        mock.accessTokens.delete(second);
        const seen = mock.bearers.length;
        expect(yield* whoami("linear")).toContain("account=spawn");
        expect(mock.refreshes).toBe(2);
        expect(mock.bearers.slice(seen).filter((bearer) => bearer === second)).not.toHaveLength(0);
        expect(mock.bearers.at(-1)).not.toBe(second);
        expect((yield* statusOf(integration.id))?.status).toBe("connected");
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("concurrent calls on a refused token share one refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        yield* signIn(integration.id, "spawn");
        mock.accessTokens.clear();
        const results = yield* Effect.all([whoami("linear"), whoami("linear"), whoami("linear")], {
          concurrency: "unbounded",
        });
        for (const result of results) expect(result).toContain("account=spawn");
        expect(mock.refreshes).toBe(1);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("a revoked grant marks the integration as needing sign-in, without retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        yield* signIn(integration.id, "spawn");
        mock.revoked = true;
        mock.accessTokens.clear();

        const failed = yield* whoami("linear").pipe(Effect.flip);
        expect(failed.reason).toBe("sign_in_required");
        expect(mock.refreshes).toBe(1);
        const summary = yield* statusOf(integration.id);
        expect(summary?.status).toBe("needs_sign_in");
        expect(summary?.message).toMatch(/revoked|expired/);

        // Later calls fail fast: no upstream request, no refresh.
        const seen = mock.bearers.length;
        expect((yield* whoami("linear").pipe(Effect.flip)).reason).toBe("sign_in_required");
        expect(mock.refreshes).toBe(1);
        expect(mock.bearers).toHaveLength(seen);

        // A new sign-in recovers it.
        mock.revoked = false;
        yield* signIn(integration.id, "spawn");
        expect(yield* whoami("linear")).toContain("account=spawn");
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("keeps two accounts of one provider apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const spawn = yield* addLinear(mock, "linear-spawn", "Spawn Partners");
        const personal = yield* addLinear(mock, "linear-personal", "personal");
        yield* signIn(spawn.id, "spawn");
        yield* signIn(personal.id, "personal");

        expect(yield* whoami("linear-spawn")).toContain("account=spawn");
        expect(yield* whoami("linear-personal")).toContain("account=personal");
        expect(Integrations.integrationTitle(spawn)).toBe("Linear · Spawn Partners");

        // Revoking one leaves the other signed in.
        mock.revoked = true;
        for (const [token, account] of mock.accessTokens)
          if (account === "personal") mock.accessTokens.delete(token);
        expect((yield* whoami("linear-personal").pipe(Effect.flip)).reason).toBe(
          "sign_in_required",
        );
        expect(yield* whoami("linear-spawn")).toContain("account=spawn");
        expect((yield* statusOf(spawn.id))?.status).toBe("connected");
        expect((yield* statusOf(personal.id))?.status).toBe("needs_sign_in");

        const vault = yield* Vault.Vault;
        expect((yield* vault.list({})).items).toHaveLength(2);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("the callback rejects a state it did not issue, and each state works once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        const service = yield* Integrations.Integrations;
        const { authorizationUrl } = yield* service.beginSignIn(integration.id, {
          origin: COGENLY_ORIGIN,
        });
        const callback = yield* consent(authorizationUrl, "spawn");

        const forged = yield* service
          .completeSignIn({ ...callback, state: "not-a-state-we-issued" })
          .pipe(Effect.flip);
        expect(forged.reason).toBe("invalid_request");
        const mixedUp = yield* service
          .completeSignIn({ ...callback, iss: "https://evil.example" })
          .pipe(Effect.flip);
        expect(mixedUp.reason).toBe("invalid_request");
        // The mix-up attempt spent the state, so even the real response is refused now.
        const replay = yield* service.completeSignIn(callback).pipe(Effect.flip);
        expect(replay.reason).toBe("invalid_request");
        expect((yield* statusOf(integration.id))?.status).toBe("needs_sign_in");

        // Through the route: a forged state gets the expired page and no session is needed.
        const { handler, dispose } = HttpRouter.toWebHandler(
          IntegrationOAuthHttp.layer.pipe(
            Layer.provideMerge(Layer.succeed(Integrations.Integrations, service)),
          ),
          { disableLogger: true },
        );
        const page = yield* Effect.promise(() =>
          handler(new Request(`${COGENLY_ORIGIN}${CALLBACK_PATH}?state=forged&code=x`)),
        );
        expect(page.status).toBe(400);
        expect(page.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => page.text())).toContain("expired");
        yield* Effect.promise(dispose);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("never returns tokens in tool results, lists, or the change stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        const service = yield* Integrations.Integrations;
        // Every list the stream pushes, up to the one where sign-in finished.
        const pushes = yield* service.subscribe().pipe(
          Stream.map((list) => JSON.stringify(list)),
          Stream.takeUntil((list) => list.includes('"connected"')),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* signIn(integration.id, "spawn");
        const echoed = yield* whoami("linear");
        expect(echoed).toContain("account=spawn");

        const secrets = [...mock.accessTokens.keys(), ...mock.refreshTokens.keys()];
        expect(secrets.length).toBeGreaterThan(0);
        const listed = JSON.stringify(yield* service.list());
        const tools = JSON.stringify(
          yield* service.listTools(IntegrationName.make("linear"), undefined),
        );
        const stream = [...(yield* Fiber.join(pushes))].join("\n");
        expect(stream).toContain('"connected"');
        for (const secret of secrets)
          for (const text of [echoed, listed, tools, stream]) expect(text).not.toContain(secret);
        expect(listed).not.toContain("oauthState");
        expect(listed).not.toContain(mock.base + "/auth/token");
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );

  it.effect("a new URL forgets the sign-in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const mock = yield* startMockAuthServer;
        const integration = yield* addLinear(mock, "linear");
        yield* signIn(integration.id, "spawn");
        const service = yield* Integrations.Integrations;
        yield* service.update({ id: integration.id, url: `${mock.base}/mcp?moved=1` });
        expect((yield* statusOf(integration.id))?.status).toBe("needs_sign_in");
        const vault = yield* Vault.Vault;
        expect((yield* vault.list({})).items).toHaveLength(0);
      }),
    ).pipe(Effect.provide(gatewayLayer())),
  );
});

it.effect.each([false, true])(
  "OAuth sign-in answer notifies its originating thread (denied: %s)",
  (denied) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const mock = yield* startMockAuthServer;
      const integration = yield* addLinear(mock, "notify-linear");
      const service = yield* Integrations.Integrations;
      const events = yield* InlineCardEvents.InlineCardEvents;
      const threadId = ThreadId.make("thread:oauth-answer");
      const link = yield* service.beginSignIn(integration.id, { origin: COGENLY_ORIGIN, threadId });
      const callback = yield* consent(link.authorizationUrl, "spawn");
      const result = yield* service
        .completeSignIn(
          denied ? { ...callback, code: undefined, error: "access_denied" } : callback,
        )
        .pipe(Effect.result);
      expect(result._tag).toBe(denied ? "Failure" : "Success");
      const answer = yield* Queue.take(events.answers);
      expect(answer.threadId).toBe(threadId);
      expect(answer.summary).toContain(denied ? "denied" : "signed in");
      expect(answer.key.includes(callback.state!)).toBe(false);
      yield* service.completeSignIn(callback).pipe(Effect.ignore);
      expect(yield* Queue.size(events.answers)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(gatewayLayer())),
);
