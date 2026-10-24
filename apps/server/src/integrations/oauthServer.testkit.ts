/**
 * A local OAuth 2.1 authorization server and MCP resource server for
 * integration sign-in tests, and a stand-in for the browser that consents.
 */
import { loopbackHttpsFetch } from "./https.testkit.ts";
import { expect } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

import { IntegrationName } from "@t3tools/contracts";

import { CALLBACK_PATH } from "./IntegrationOAuth.ts";

/**
 * A local OAuth 2.1 authorization server and MCP resource server in one:
 * protected-resource and authorization-server metadata, dynamic client
 * registration, PKCE authorization codes bound to `resource`, rotating
 * refresh tokens, and an MCP endpoint that answers 401 with a
 * `resource_metadata` challenge to anything without a live token.
 */
export interface MockAuthServer {
  base: string;
  registrations: number;
  refreshes: number;
  /** Refresh tokens answer invalid_grant, as after the user revokes access. */
  revoked: boolean;
  omitPkce?: boolean;
  requireIssuer?: boolean;
  /** Registered clients get a secret and authenticate with client_secret_post. */
  confidential?: boolean;
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
  /** Every token and client secret this server ever handed out. */
  readonly issued: Array<string>;
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers });

export const startMockAuthServer = Effect.gen(function* () {
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
    issued: [],
  };
  let issued = 0;
  const refreshClients = new Map<string, string>();
  const issue = (account: string, clientId: string) => {
    issued += 1;
    const accessToken = `access-${account}-${issued}-secretvalue`;
    const refreshToken = `refresh-${account}-${issued}-secretvalue`;
    mock.accessTokens.set(accessToken, account);
    mock.refreshTokens.set(refreshToken, account);
    refreshClients.set(refreshToken, clientId);
    mock.issued.push(accessToken, refreshToken);
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
          ...(mock.omitPkce ? {} : { code_challenge_methods_supported: ["S256"] }),
          authorization_response_iss_parameter_supported: mock.requireIssuer === true,
          token_endpoint_auth_methods_supported: mock.confidential
            ? ["client_secret_post"]
            : ["none"],
        }),
      ),
    ),
    HttpRouter.add("POST", "/auth/register", (request) =>
      request.json.pipe(
        Effect.map((body) => {
          mock.registrations += 1;
          const clientId = `client-${mock.registrations}`;
          mock.clients.set(clientId, (body as { redirect_uris: Array<string> }).redirect_uris);
          if (!mock.confidential)
            return reply({ client_id: clientId, token_endpoint_auth_method: "none" }, 201);
          const secret = `client-secret-${mock.registrations}-secretvalue`;
          mock.issued.push(secret);
          return reply(
            {
              client_id: clientId,
              client_secret: secret,
              token_endpoint_auth_method: "client_secret_post",
            },
            201,
          );
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
        Effect.tap(() => {
          const gate = mock.tokenGate;
          return gate === undefined
            ? Effect.void
            : Deferred.succeed(gate.entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate.resume)),
              );
        }),
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
            return reply(issue(grant.account, grant.clientId));
          }
          if (params.get("grant_type") === "refresh_token") {
            mock.refreshes += 1;
            const refreshToken = params.get("refresh_token") ?? "";
            const clientId = params.get("client_id") ?? "";
            if (!mock.clients.has(clientId) || refreshClients.get(refreshToken) !== clientId)
              return reply({ error: "invalid_client" }, 401);
            const account = mock.refreshTokens.get(refreshToken);
            if (mock.revoked || account === undefined)
              return reply({ error: "invalid_grant" }, 400);
            mock.refreshTokens.delete(params.get("refresh_token") ?? "");
            return reply(issue(account, clientId));
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
  mock.base = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address).replace(
    /^http:/,
    "https:",
  );
  return mock;
});

/** Where clients reach Cogenly in these tests; the callback is never fetched. */
export const COGENLY_ORIGIN = "https://cogenly.example";

/** A web integration that signs in to the mock server with OAuth. */
export const linearInput = (mock: MockAuthServer, name: string, accountLabel?: string) => ({
  name: IntegrationName.make(name),
  displayName: "Linear",
  transport: "http" as const,
  url: `${mock.base}/mcp`,
  headers: {},
  scope: { type: "all" as const },
  hint: "",
  auth: { type: "oauth" as const },
  ...(accountLabel === undefined ? {} : { accountLabel }),
});

/** Plays the browser: opens the link, consents as `account`, and returns the callback query. */
export const consent = (authorizationUrl: string, account: string, origin = COGENLY_ORIGIN) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(authorizationUrl);
    url.searchParams.set("account", account);
    const response = yield* client
      .execute(HttpClientRequest.get(url.href))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(FetchHttpClient.Fetch, loopbackHttpsFetch),
      );
    expect(response.status).toBe(302);
    const back = new URL(response.headers.location!);
    expect(`${back.origin}${back.pathname}`).toBe(`${origin}${CALLBACK_PATH}`);
    return {
      state: back.searchParams.get("state") ?? undefined,
      code: back.searchParams.get("code") ?? undefined,
      error: back.searchParams.get("error") ?? undefined,
      iss: back.searchParams.get("iss") ?? undefined,
    };
  });
