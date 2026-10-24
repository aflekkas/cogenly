import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpMiddleware } from "effect/http";
import * as Local from "./LocalIntegrations.ts";
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_CLIENT_HELP,
  GOOGLE_SIGN_IN_PATH,
} from "./GoogleWorkspace.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

/** Capability links initiate sign-in; the upstream OAuth state routes its public callback to one managed account. */
export const layer = Layer.merge(
  HttpRouter.add(
    "GET",
    GOOGLE_SIGN_IN_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const local = yield* Local.LocalIntegrations;
      const ticket = new URL(request.url, "http://localhost").searchParams.get("ticket") ?? "";
      return yield* local.authorize(ticket).pipe(
        Effect.map((result) =>
          result.url
            ? HttpServerResponse.redirect(result.url, { headers })
            : HttpServerResponse.text("Google is already connected. You can return to Cogenly.", {
                headers,
              }),
        ),
        Effect.catchTags({
          IntegrationError: (error) =>
            Effect.succeed(
              HttpServerResponse.text(
                error.reason === "google_client_missing"
                  ? GOOGLE_CLIENT_HELP
                  : error.reason === "local_runtime_missing"
                    ? "Install uv: brew install uv (macOS), or https://docs.astral.sh/uv/getting-started/installation/ (Linux). Restart Cogenly and open the sign-in link again."
                    : "Google sign-in could not start. Start sign-in again from Settings → Integrations, and check the account status there.",
                { status: 400, headers },
              ),
            ),
        }),
      );
    }).pipe(HttpMiddleware.withLoggerDisabled, Effect.withTracerEnabled(false)),
  ),
  // Callback never accepts an upstream URL, port, account id or arbitrary proxy path.
  // OAuth's high-entropy state, recorded from the managed process's consent link, chooses the destination.
  // Invalid/replayed state never reaches a process.
  HttpRouter.add(
    "GET",
    GOOGLE_CALLBACK_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const local = yield* Local.LocalIntegrations;
      const query = new URL(request.url, "http://localhost").searchParams.toString();
      const connected = yield* local.callback(query).pipe(Effect.orElseSucceed(() => false));
      return HttpServerResponse.text(
        connected
          ? "Google connected. You can return to Cogenly."
          : "Google sign-in did not complete, or the link expired. Return to Cogenly and request a fresh sign-in link.",
        { status: connected ? 200 : 400, headers },
      );
    }).pipe(HttpMiddleware.withLoggerDisabled, Effect.withTracerEnabled(false)),
  ),
);
