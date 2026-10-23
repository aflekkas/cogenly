import { IntegrationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { base64UrlEncode } from "../auth/utils.ts";

/**
 * The OAuth 2.1 client the gateway uses to sign in to upstream MCP servers,
 * per the MCP authorization spec (2025-06-18): protected-resource then
 * authorization-server discovery, dynamic client registration, the PKCE
 * authorization-code grant with `resource`, and refresh. Stateless; the
 * Integrations service owns pending sign-ins, stored tokens and single flight.
 * Token values never reach an error, a log, or a caller other than the gateway.
 */

/** Where the browser returns after consent, on the origin that started sign-in. */
export const CALLBACK_PATH = "/oauth/integrations/callback";

const METADATA_TIMEOUT = Duration.seconds(10);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_CODE_CHARS = 64;

/** What sign-in needs to know about an upstream server; persisted with the integration. */
export const OAuthServer = Schema.Struct({
  /** The canonical MCP resource URI sent as `resource`. */
  resource: Schema.String,
  issuer: Schema.String,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  registrationEndpoint: Schema.optional(Schema.String),
  scopesSupported: Schema.optional(Schema.Array(Schema.String)),
  tokenEndpointAuthMethods: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthServer = typeof OAuthServer.Type;

export const ClientAuthMethod = Schema.Literals([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);
export type ClientAuthMethod = typeof ClientAuthMethod.Type;

/** A dynamically registered client; its secret, when issued, is a vault field. */
export const OAuthClientRegistration = Schema.Struct({
  clientId: Schema.String,
  authMethod: ClientAuthMethod,
  redirectUris: Schema.Array(Schema.String),
});
export type OAuthClientRegistration = typeof OAuthClientRegistration.Type;

/** The client a token request authenticates as. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly authMethod: ClientAuthMethod;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  /** Epoch milliseconds, or null when the server did not say. */
  readonly expiresAt: number | null;
}

/**
 * A token endpoint refusal. `revoked` means the grant is gone (invalid_grant
 * and friends): only a new browser sign-in helps, so callers must not retry.
 */
export class OAuthTokenError extends Schema.TaggedError<OAuthTokenError>()("OAuthTokenError", {
  revoked: Schema.Boolean,
  code: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.revoked
      ? "The sign-in was revoked or expired."
      : `The token request failed${this.code ? ` (${this.code})` : ""}.`;
  }
}

const failure = (operation: string, detail?: string) =>
  new IntegrationError({ operation, reason: "upstream_error", cause: detail });

const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.optional(Schema.String),
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});
const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
});
const RegistrationResponse = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
});
const TokenErrorResponse = Schema.Struct({ error: Schema.String });

const decodeResourceMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProtectedResourceMetadata),
);
const decodeServerMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(AuthorizationServerMetadata),
);
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(RegistrationResponse));
const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse));
const decodeTokenError = Schema.decodeUnknownOption(Schema.fromJsonString(TokenErrorResponse));
const isIntegrationError = Schema.is(IntegrationError);

/** `resource_metadata` from a `WWW-Authenticate: Bearer ...` challenge. */
export const resourceMetadataFromChallenge = (header: string | undefined): string | undefined =>
  header === undefined ? undefined : /resource_metadata="([^"]+)"/i.exec(header)?.[1];

const stripSlash = (value: string) => value.replace(/\/+$/, "");

/**
 * An endpoint the gateway may call: http(s), and https whenever the MCP
 * server itself is https, so a plain-http hop cannot carry codes or tokens.
 */
const checkEndpoint = (value: string, mcpUrl: URL) => {
  const url = URL.parse(value);
  if (url === null) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (mcpUrl.protocol === "https:" && url.protocol !== "https:") return undefined;
  return url;
};

export const pkcePair = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = base64UrlEncode(yield* crypto.randomBytes(32));
  const challenge = base64UrlEncode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}).pipe(Effect.mapError(() => failure("sign in", "random")));

export const randomState = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return base64UrlEncode(yield* crypto.randomBytes(32));
}).pipe(Effect.mapError(() => failure("sign in", "random")));

/** The authorization URL the user opens; `resource` binds the grant to this MCP server. */
export const authorizationUrl = (input: {
  readonly server: OAuthServer;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly scope: string | undefined;
}): string => {
  const url = new URL(input.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.server.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.href;
};

/** How to authenticate a client with a secret, preferring what the server lists first. */
export const secretAuthMethod = (server: OAuthServer): ClientAuthMethod =>
  server.tokenEndpointAuthMethods?.includes("client_secret_basic") ||
  !server.tokenEndpointAuthMethods?.includes("client_secret_post")
    ? "client_secret_basic"
    : "client_secret_post";

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  /** One bounded request; redirects are never followed, so codes and secrets stay put. */
  const send = (request: HttpClientRequest.HttpClientRequest, operation: string) =>
    Effect.gen(function* () {
      const response = yield* client
        .execute(request)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const decoder = new TextDecoder();
      let bytes = 0;
      const text = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => "",
          (text, chunk) => {
            bytes += chunk.byteLength;
            return bytes > MAX_RESPONSE_BYTES
              ? Effect.fail(failure(operation, "response too large"))
              : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
          },
        ),
        Effect.map((text) => text + decoder.decode()),
      );
      return { status: response.status, headers: response.headers, text };
    }).pipe(
      Effect.timeout(METADATA_TIMEOUT),
      Effect.mapError((cause) =>
        isIntegrationError(cause)
          ? cause
          : new IntegrationError({ operation, reason: "upstream_unreachable" }),
      ),
    );

  /** The first of `urls` that answers with a document `decode` accepts. */
  const firstJson = <A>(
    urls: ReadonlyArray<string>,
    decode: (text: string) => Option.Option<A>,
    operation: string,
  ) =>
    Effect.gen(function* () {
      for (const url of urls) {
        const found = yield* send(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
          operation,
        ).pipe(
          Effect.map((response) =>
            response.status >= 200 && response.status < 300
              ? decode(response.text)
              : Option.none<A>(),
          ),
          Effect.orElseSucceed(() => Option.none<A>()),
        );
        if (Option.isSome(found)) return found;
      }
      return Option.none<A>();
    });

  /** RFC 8414 / OIDC discovery URLs for an issuer, path-aware first. */
  const authorizationServerUrls = (issuer: URL) => {
    const path = stripSlash(issuer.pathname);
    return path === ""
      ? [
          `${issuer.origin}/.well-known/oauth-authorization-server`,
          `${issuer.origin}/.well-known/openid-configuration`,
        ]
      : [
          `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
          `${issuer.origin}/.well-known/openid-configuration${path}`,
          `${issuer.origin}${path}/.well-known/openid-configuration`,
        ];
  };

  /**
   * Finds the authorization server for an MCP endpoint. An unauthenticated
   * request names the resource metadata in its 401 challenge; otherwise the
   * well-known locations are tried. A server with no resource metadata is its
   * own authorization server (the 2025-03-26 behavior).
   */
  const discover = (mcpUrl: string) =>
    Effect.gen(function* () {
      const endpoint = new URL(mcpUrl);
      const probe = yield* send(
        HttpClientRequest.post(mcpUrl).pipe(
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "cogenly", version: "1" },
            },
          }),
        ),
        "discover",
      ).pipe(Effect.option);
      const challenged = Option.flatMapNullishOr(probe, (response) =>
        resourceMetadataFromChallenge(response.headers["www-authenticate"]),
      );
      const path = stripSlash(endpoint.pathname);
      const resourceUrls = [
        ...Option.toArray(challenged).flatMap((url) =>
          checkEndpoint(url, endpoint) === undefined ? [] : [url],
        ),
        ...(path === "" ? [] : [`${endpoint.origin}/.well-known/oauth-protected-resource${path}`]),
        `${endpoint.origin}/.well-known/oauth-protected-resource`,
      ];
      const resourceMetadata = yield* firstJson(resourceUrls, decodeResourceMetadata, "discover");
      const advertised = Option.flatMapNullishOr(
        resourceMetadata,
        (metadata) => metadata.authorization_servers?.[0],
      );
      const issuer = checkEndpoint(
        Option.getOrElse(advertised, () => endpoint.origin),
        endpoint,
      );
      if (issuer === undefined) return yield* failure("discover", "authorization server");
      const metadata = yield* firstJson(
        authorizationServerUrls(issuer),
        decodeServerMetadata,
        "discover",
      );
      if (Option.isNone(metadata)) return yield* failure("discover", "no authorization server");
      const found = metadata.value;
      // RFC 8414 §3.3: the metadata must describe the issuer it was fetched for.
      if (stripSlash(found.issuer) !== stripSlash(issuer.href))
        return yield* failure("discover", "issuer mismatch");
      if (
        found.code_challenge_methods_supported !== undefined &&
        !found.code_challenge_methods_supported.includes("S256")
      )
        return yield* failure("discover", "no PKCE");
      const authorizationEndpoint = checkEndpoint(found.authorization_endpoint, endpoint);
      const tokenEndpoint = checkEndpoint(found.token_endpoint, endpoint);
      const registrationEndpoint =
        found.registration_endpoint === undefined
          ? undefined
          : checkEndpoint(found.registration_endpoint, endpoint);
      if (authorizationEndpoint === undefined || tokenEndpoint === undefined)
        return yield* failure("discover", "endpoints");
      // The resource the metadata names, when it is this server; else the endpoint itself.
      const named = Option.flatMapNullishOr(resourceMetadata, (metadata) => metadata.resource);
      const resource =
        Option.isSome(named) && URL.parse(named.value)?.origin === endpoint.origin
          ? named.value
          : endpoint.href;
      const scopes = Option.flatMapNullishOr(
        resourceMetadata,
        (metadata) => metadata.scopes_supported,
      );
      return {
        resource,
        issuer: found.issuer,
        authorizationEndpoint: authorizationEndpoint.href,
        tokenEndpoint: tokenEndpoint.href,
        ...(registrationEndpoint === undefined
          ? {}
          : { registrationEndpoint: registrationEndpoint.href }),
        ...(Option.isSome(scopes) ? { scopesSupported: scopes.value } : {}),
        ...(found.token_endpoint_auth_methods_supported === undefined
          ? {}
          : { tokenEndpointAuthMethods: found.token_endpoint_auth_methods_supported }),
      } satisfies OAuthServer;
    });

  /** Dynamic client registration (RFC 7591) as a public client using PKCE. */
  const register = (server: OAuthServer, redirectUri: string) =>
    Effect.gen(function* () {
      if (server.registrationEndpoint === undefined)
        return yield* new IntegrationError({ operation: "register", reason: "client_id_required" });
      const response = yield* send(
        HttpClientRequest.post(server.registrationEndpoint).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyJsonUnsafe({
            client_name: "Cogenly",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        ),
        "register",
      );
      const registered =
        response.status >= 200 && response.status < 300
          ? decodeRegistration(response.text)
          : Option.none();
      if (Option.isNone(registered)) return yield* failure("register", "rejected");
      const { client_id, client_secret, token_endpoint_auth_method } = registered.value;
      const authMethod: ClientAuthMethod =
        client_secret === undefined
          ? "none"
          : token_endpoint_auth_method === "client_secret_post"
            ? "client_secret_post"
            : "client_secret_basic";
      return {
        registration: { clientId: client_id, authMethod, redirectUris: [redirectUri] },
        clientSecret: client_secret,
      };
    });

  /** One token request; refusals carry only the OAuth error code. */
  const token = (
    server: OAuthServer,
    oauthClient: OAuthClient,
    params: Record<string, string>,
    operation: string,
  ) =>
    Effect.gen(function* () {
      let request = HttpClientRequest.post(server.tokenEndpoint).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
      );
      const body: Record<string, string> = { ...params, resource: server.resource };
      if (oauthClient.authMethod === "client_secret_basic" && oauthClient.clientSecret) {
        // RFC 6749 §2.3.1: both parts are form-encoded before Basic encoding.
        request = HttpClientRequest.basicAuth(
          request,
          encodeURIComponent(oauthClient.clientId),
          encodeURIComponent(oauthClient.clientSecret),
        );
      } else {
        body.client_id = oauthClient.clientId;
        if (oauthClient.authMethod === "client_secret_post" && oauthClient.clientSecret)
          body.client_secret = oauthClient.clientSecret;
      }
      const response = yield* send(HttpClientRequest.bodyUrlParams(request, body), operation).pipe(
        Effect.mapError(() => new OAuthTokenError({ revoked: false })),
      );
      if (response.status >= 200 && response.status < 300) {
        const decoded = decodeToken(response.text);
        if (Option.isNone(decoded)) return yield* new OAuthTokenError({ revoked: false });
        return decoded.value;
      }
      const code = Option.map(decodeTokenError(response.text), (error) =>
        error.error.slice(0, MAX_ERROR_CODE_CHARS),
      );
      return yield* new OAuthTokenError({
        revoked:
          (response.status === 400 || response.status === 401) &&
          Option.isSome(code) &&
          ["invalid_grant", "invalid_client", "unauthorized_client"].includes(code.value),
        ...(Option.isSome(code) ? { code: code.value } : {}),
      });
    });

  const tokenSet = (
    response: typeof TokenResponse.Type,
    nowMs: number,
    previousRefresh?: string,
  ): TokenSet => ({
    accessToken: response.access_token,
    // A server that does not rotate refresh tokens leaves the old one valid.
    refreshToken: response.refresh_token ?? previousRefresh,
    expiresAt:
      response.expires_in === undefined || !Number.isFinite(response.expires_in)
        ? null
        : nowMs + Math.max(0, response.expires_in) * 1000,
  });

  return {
    discover,
    register,
    exchangeCode: (input: {
      readonly server: OAuthServer;
      readonly client: OAuthClient;
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
      readonly nowMs: number;
    }) =>
      token(
        input.server,
        input.client,
        {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        },
        "exchange code",
      ).pipe(Effect.map((response) => tokenSet(response, input.nowMs))),
    refresh: (input: {
      readonly server: OAuthServer;
      readonly client: OAuthClient;
      readonly refreshToken: string;
      readonly nowMs: number;
    }) =>
      token(
        input.server,
        input.client,
        { grant_type: "refresh_token", refresh_token: input.refreshToken },
        "refresh",
      ).pipe(Effect.map((response) => tokenSet(response, input.nowMs, input.refreshToken))),
  };
});

export type OAuthProtocol = Effect.Success<typeof make>;
