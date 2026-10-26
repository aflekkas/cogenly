import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as Layer from "effect/Layer";
import { CALLBACK_PATH, CLIENT_METADATA_PATH, clientMetadataDocument } from "./IntegrationOAuth.ts";
import * as Integrations from "./Integrations.ts";

/**
 * Where an upstream authorization server sends the browser after consent.
 * It needs no Cogenly session: the browser may not be the one signed in to
 * Cogenly, and the single-use `state`, bound server-side to the PKCE
 * verifier, is what authorizes it. Clients hear about the result through
 * `integrations.subscribe`.
 */

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export const callbackPage = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#555}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}p{color:#aaa}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;

export const layer = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    CLIENT_METADATA_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
      if (!url) return HttpServerResponse.empty({ status: 400 });
      // Metadata client identifiers are HTTPS-only, including behind a TLS terminator.
      return HttpServerResponse.jsonUnsafe(clientMetadataDocument(`https://${url.host}`), {
        headers: { "cache-control": "public, max-age=300" },
      });
    }),
  ),
  HttpRouter.add(
    "GET",
    CALLBACK_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = Option.match(HttpServerRequest.toURL(request), {
        onNone: () => new URLSearchParams(),
        onSome: (url) => url.searchParams,
      });
      const param = (name: string) => params.get(name) ?? undefined;
      const integrations = yield* Integrations.Integrations;
      const result = yield* integrations
        .completeSignIn({
          state: param("state"),
          code: param("code"),
          error: param("error"),
          errorDescription: param("error_description"),
          iss: param("iss"),
        })
        .pipe(Effect.result);
      const page =
        result._tag === "Success"
          ? callbackPage(
              `Signed in to ${Integrations.integrationTitle(result.success.integration)}`,
              "Agents can use it now. You can close this tab and go back to Cogenly.",
            )
          : result.failure.reason === "invalid_request"
            ? callbackPage(
                "This sign-in link has expired",
                "It was already used, timed out, or did not come from Cogenly. Start sign-in again from the integration card in your thread.",
              )
            : callbackPage("Sign-in couldn't finish", result.failure.message);
      return HttpServerResponse.text(page, {
        status: result._tag === "Success" ? 200 : 400,
        contentType: "text/html; charset=utf-8",
        headers: PAGE_HEADERS,
      });
    }),
  ),
);
