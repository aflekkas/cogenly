import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto as EffectNodeCrypto, NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, IntegrationName, type IntegrationId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The mock authorization server checks PKCE with a plain SHA-256.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes a node:http server factory.
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Vault from "../vault/Vault.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import { CALLBACK_PATH } from "./IntegrationOAuth.ts";
import * as Integrations from "./Integrations.ts";
import * as IntegrationOAuthHttp from "./integrationOAuthHttp.ts";
import * as Tokens from "./IntegrationTokens.ts";
import { IntegrationEndpointPolicy } from "./RemoteEndpoint.ts";

/**
 * A local OAuth 2.1 authorization server and MCP resource server in one:
 * protected-resource and authorization-server metadata, dynamic client
 * registration, PKCE authorization codes bound to `resource`, rotating
 * refresh tokens, and an MCP endpoint that answers 401 with a
 * `resource_metadata` challenge to anything without a live token.
 */
interface MockAuthServer {
  base: string;
  registrations: number;
  refreshes: number;
  /** Refresh tokens answer invalid_grant, as after the user revokes access. */
  revoked: boolean;
  tokenGate?: { entered: Deferred.Deferred<void>; resume: Deferred.Deferred<void> };
  readonly clients: Map<string, ReadonlyArray<string>>;
  readonly codes: Map<
    string,
    { clientId: string; challenge: string; redirectUri: string; account: string; resource: string }
  >;
  /** Live access tokens, by token: the account they act for. */
  readonly accessTokens: Map<string, string>;
  readonly refreshTokens: Map<string, string>;
  /** Every bearer the MCP endpoint saw, in order. */
  readonly bearers: Array<string | undefined>;
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });

const startMockAuthServer = Effect.gen(function* () {
  const mock: MockAuthServer = {
    base: "",
    registrations: 0,
    refreshes: 0,
    revoked: false,
    clients: new Map(),
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    bearers: [],
  };
  let issued = 0;
  const issue = (account: string) => {
    issued += 1;
    const accessToken = `access-${account}-${issued}-secretvalue`;
    const refreshToken = `refresh-${account}-${issued}-secretvalue`;
    mock.accessTokens.set(accessToken, account);
    mock.refreshTokens.set(refreshToken, account);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
    };
  };
  const form = (request: HttpServerRequest.HttpServerRequest) =>
    request.text.pipe(Effect.map((text) => new URLSearchParams(text)));

  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp", () =>
      Effect.succeed(
        reply({
          resource: `${mock.base}/mcp`,
          authorization_servers: [`${mock.base}/auth`],
          scopes_supported: ["read", "write"],
        }),
      ),
    ),
    // Path-aware RFC 8414 metadata: the issuer has a path.
    HttpRouter.add("GET", "/.well-known/oauth-authorization-server/auth", () =>
      Effect.succeed(
        reply({
          issuer: `${mock.base}/auth`,
          authorization_endpoint: `${mock.base}/auth/authorize`,
          token_endpoint: `${mock.base}/auth/token`,
          registration_endpoint: `${mock.base}/auth/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      ),
    ),
    HttpRouter.add("POST", "/auth/register", (request) =>
      request.json.pipe(
        Effect.map((body) => {
          mock.registrations += 1;
          const clientId = `client-${mock.registrations}`;
          mock.clients.set(clientId, (body as { redirect_uris: Array<string> }).redirect_uris);
          return reply({ client_id: clientId, token_endpoint_auth_method: "none" }, 201);
        }),
        Effect.orDie,
      ),
    ),
    // Consent: the test plays the browser and picks the account with `account`.
    HttpRouter.add("GET", "/auth/authorize", (request) =>
      Effect.sync(() => {
        const params = new URL(request.url, mock.base).searchParams;
        const clientId = params.get("client_id") ?? "";
        const redirectUri = params.get("redirect_uri") ?? "";
        if (
          !mock.clients.get(clientId)?.includes(redirectUri) ||
          params.get("code_challenge_method") !== "S256" ||
          params.get("response_type") !== "code"
        )
          return reply({ error: "invalid_request" }, 400);
        const code = `code-${mock.codes.size + 1}`;
        mock.codes.set(code, {
          clientId,
          challenge: params.get("code_challenge") ?? "",
          redirectUri,
          account: params.get("account") ?? "default",
          resource: params.get("resource") ?? "",
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", params.get("state") ?? "");
        back.searchParams.set("iss", `${mock.base}/auth`);
        return HttpServerResponse.redirect(back.href, { status: 302 });
      }),
    ),
    HttpRouter.add("POST", "/auth/token", (request) =>
      form(request).pipe(
        Effect.tap(() =>
          mock.tokenGate === undefined
            ? Effect.void
            : Effect.gen(function* () {
                yield* Deferred.succeed(mock.tokenGate!.entered, undefined);
                yield* Deferred.await(mock.tokenGate!.resume);
              }),
        ),
        Effect.map((params) => {
          if (params.get("resource") !== `${mock.base}/mcp`)
            return reply({ error: "invalid_target" }, 400);
          if (params.get("grant_type") === "authorization_code") {
            const grant = mock.codes.get(params.get("code") ?? "");
            mock.codes.delete(params.get("code") ?? "");
            const verifier = params.get("code_verifier") ?? "";
            const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
            if (
              grant === undefined ||
              grant.clientId !== params.get("client_id") ||
              grant.redirectUri !== params.get("redirect_uri") ||
              grant.challenge !== challenge ||
              grant.resource !== `${mock.base}/mcp`
            )
              return reply({ error: "invalid_grant" }, 400);
            return reply(issue(grant.account));
          }
          if (params.get("grant_type") === "refresh_token") {
            mock.refreshes += 1;
            const account = mock.refreshTokens.get(params.get("refresh_token") ?? "");
            if (mock.revoked || account === undefined)
              return reply({ error: "invalid_grant" }, 400);
            mock.refreshTokens.delete(params.get("refresh_token") ?? "");
            return reply(issue(account));
          }
          return reply({ error: "unsupported_grant_type" }, 400);
        }),
        Effect.orDie,
      ),
    ),
    HttpRouter.add("POST", "/mcp", (request) =>
      request.json.pipe(
        Effect.map((raw) => {
          const body = raw as { id: number; method: string; params?: { name?: string } };
          const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
          mock.bearers.push(bearer);
          const account = bearer === undefined ? undefined : mock.accessTokens.get(bearer);
          if (account === undefined)
            return reply({ error: "invalid_token" }, 401, {
              "www-authenticate": `Bearer resource_metadata="${mock.base}/.well-known/oauth-protected-resource/mcp"`,
            });
          if (body.method === "initialize")
            return reply({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18" },
            });
          if (body.method === "tools/list")
            return reply({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: [{ name: "whoami", description: "", inputSchema: {} }] },
            });
          // Echoes the bearer back, as a careless server might.
          return reply({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: `account=${account} token=${bearer}` }],
            },
          });
        }),
        Effect.orDie,
      ),
    ),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
      ),
    ),
  );
  mock.base = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address);
  return mock;
});

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));

/** The gateway over the real vault, as in production. */
const gatewayLayer = () => {
  const stored = new Map<string, Uint8Array>();
  return Integrations.layer.pipe(
    // The mock servers listen on loopback, which production refuses.
    Layer.provide(Layer.succeed(IntegrationEndpointPolicy, () => Effect.succeed(undefined))),
    Layer.provideMerge(Credentials.layer),
    Layer.provideMerge(Tokens.layer),
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

/** Where clients reach Cogenly in these tests; the callback is never fetched. */
const COGENLY_ORIGIN = "https://cogenly.example";

const addLinear = (mock: MockAuthServer, name: string, accountLabel?: string) =>
  Effect.gen(function* () {
    const service = yield* Integrations.Integrations;
    const { integration } = yield* service.create({
      name: IntegrationName.make(name),
      displayName: "Linear",
      transport: "http",
      url: `${mock.base}/mcp`,
      headers: {},
      scope: { type: "all" },
      hint: "",
      auth: { type: "oauth" },
      ...(accountLabel === undefined ? {} : { accountLabel }),
    });
    return integration;
  });

/** Plays the browser: opens the link, consents as `account`, and returns the callback query. */
const consent = (authorizationUrl: string, account: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(authorizationUrl);
    url.searchParams.set("account", account);
    const response = yield* client
      .execute(HttpClientRequest.get(url.href))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    expect(response.status).toBe(302);
    const back = new URL(response.headers.location!);
    expect(`${back.origin}${back.pathname}`).toBe(`${COGENLY_ORIGIN}${CALLBACK_PATH}`);
    return {
      state: back.searchParams.get("state") ?? undefined,
      code: back.searchParams.get("code") ?? undefined,
      error: back.searchParams.get("error") ?? undefined,
      iss: back.searchParams.get("iss") ?? undefined,
    };
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
              Layer.provide(
                Layer.succeed(IntegrationEndpointPolicy, () => Effect.succeed(undefined)),
              ),
            ),
          ),
          Integrations.Integrations,
        );
        const link = yield* restarted.beginSignIn(integration.id, {
          origin: "http://localhost:3000",
          fromAgent: true,
        });
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
          expect((yield* vault.list({})).items).toHaveLength(0);
          expect(mock.bearers.filter((bearer) => bearer !== undefined)).toHaveLength(0);
          if (mutation === "edit")
            expect((yield* statusOf(integration.id))?.status).toBe("needs_sign_in");
        }),
      ).pipe(Effect.provide(gatewayLayer())),
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
