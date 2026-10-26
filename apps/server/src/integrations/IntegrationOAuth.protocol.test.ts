import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as OAuth from "./IntegrationOAuth.ts";
import { IntegrationEndpointPolicy } from "./RemoteEndpoint.ts";

const server: OAuth.OAuthServer = {
  resource: "https://resource.example/connect/mcp",
  issuer: "https://auth.example",
  authorizationEndpoint: "https://auth.example/authorize",
  tokenEndpoint: "https://auth.example/token",
};
const protocol = (fetch: typeof globalThis.fetch) =>
  OAuth.make.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(IntegrationEndpointPolicy, () => Effect.succeed(undefined)),
  );

describe("MCP OAuth protocol", () => {
  it.effect("uses the challenge scope and cross-origin RFC 9728 AS, with OIDC fallback", () => {
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === server.resource)
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://resource.example/metadata", scope="openid offline_access"',
          },
        });
      if (url === "https://resource.example/metadata")
        return Response.json({
          resource: server.resource,
          authorization_servers: ["https://auth.example/tenant"],
        });
      if (url === "https://auth.example/tenant/.well-known/openid-configuration")
        return Response.json({
          issuer: "https://auth.example/tenant",
          authorization_endpoint: server.authorizationEndpoint,
          token_endpoint: server.tokenEndpoint,
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["too_broad"],
        });
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    return Effect.gen(function* () {
      const client = yield* protocol(fetch);
      // The fetch belongs to requests too, not just construction.
      const discovered = yield* client
        .discover(server.resource)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(discovered.issuer).toBe("https://auth.example/tenant");
      expect(discovered.scopesSupported).toEqual(["openid", "offline_access"]);
      expect(requests).toContain(
        "https://auth.example/.well-known/oauth-authorization-server/tenant",
      );
      expect(requests).toContain("https://auth.example/tenant/.well-known/openid-configuration");
      expect(
        requests.some((url) =>
          url.startsWith("https://resource.example/.well-known/oauth-authorization-server"),
        ),
      ).toBe(false);
    });
  });

  it.effect("surfaces the discovery HTTP status and OAuth error", () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(
        { error: "temporarily_unavailable", error_description: "Try discovery later" },
        { status: 503 },
      );
    return Effect.gen(function* () {
      const client = yield* protocol(fetch);
      const error = yield* client
        .discover(server.resource)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip);
      expect(error.oauthFailure).toMatchObject({
        stage: "discovery",
        host: "resource.example",
        status: 503,
        error: "temporarily_unavailable",
        description: "Try discovery later",
      });
    });
  });

  it.effect("binds token exchange to resource and surfaces the token error", () => {
    let form = new URLSearchParams();
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      form = new URLSearchParams(String(init?.body));
      return Response.json(
        { error: "invalid_grant", error_description: "Code expired" },
        { status: 400 },
      );
    };
    return Effect.gen(function* () {
      const client = yield* protocol(fetch);
      const error = yield* client
        .exchangeCode({
          server,
          client: { clientId: "public-client", authMethod: "none" },
          code: "one-use-code",
          verifier: "pkce-verifier",
          redirectUri: "http://127.0.0.1:4773/oauth/integrations/callback",
          nowMs: 0,
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip);
      expect(form.get("resource")).toBe(server.resource);
      expect(form.get("client_id")).toBe("public-client");
      expect(form.get("code_verifier")).toBe("pkce-verifier");
      expect(error.revoked).toBe(true);
      expect(error.oauthFailure).toEqual({
        stage: "token",
        host: "auth.example",
        status: 400,
        error: "invalid_grant",
        description: "Code expired",
      });
    });
  });
});
