import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { GrokAcpHost } from "./acp.ts";
import { readGrokCachedToken } from "./auth.ts";
import { GROK_BILLING_ACP_METHODS, GROK_BILLING_URLS, parseGrokBilling } from "./billing.ts";
import { readCachedGrokUsageLimits, writeCachedGrokUsageLimits } from "./usageLimitsCache.ts";

/** Asks a running ACP host for billing; the CLI owns auth and token refresh. */
export const readGrokBillingFromHost = Effect.fn("readGrokBillingFromHost")(function* (
  host: Pick<GrokAcpHost, "connection">,
) {
  for (const method of GROK_BILLING_ACP_METHODS) {
    const response = yield* Effect.tryPromise(() => host.connection.request(method, {})).pipe(
      Effect.timeoutOption(6_000),
      Effect.orElseSucceed(() => undefined),
    );
    const value = response?._tag === "Some" ? response.value : undefined;
    if (value === undefined) continue;
    const limits = parseGrokBilling(value, DateTime.toEpochMillis(yield* DateTime.now));
    if (limits) return limits;
  }
  return undefined;
});

/**
 * Reads billing over HTTP with the CLI's cached token. Read-only: an expired
 * token is not refreshed here, so the caller falls back to the cache.
 */
export const readGrokBillingOverHttp = Effect.fn("readGrokBillingOverHttp")(function* (
  environment: NodeJS.ProcessEnv,
  cliVersion: string | null,
) {
  const token = yield* readGrokCachedToken(environment);
  if (!token) return undefined;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  if (token.expiresAtMs !== undefined && token.expiresAtMs <= nowMs) return undefined;
  const client = yield* HttpClient.HttpClient;
  for (const url of GROK_BILLING_URLS) {
    const body = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${token.key}`,
            "x-xai-token-auth": "xai-grok-cli",
            ...(cliVersion ? { "x-grok-client-version": cliVersion } : {}),
            accept: "application/json",
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json
            : Effect.succeed(undefined),
        ),
        Effect.timeout(6_000),
        Effect.orElseSucceed(() => undefined),
      );
    if (body === undefined) continue;
    const limits = parseGrokBilling(body, nowMs);
    if (limits) return limits;
  }
  return undefined;
});

/**
 * The probe's limits: the live host, then HTTP, then the last observation.
 * A fresh observation is cached so a later failed read still shows bars,
 * stamped with when they were seen.
 */
export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (input: {
  readonly host: Pick<GrokAcpHost, "connection"> | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly cliVersion: string | null;
  readonly cachePath: string | undefined;
}) {
  const live =
    (input.host ? yield* readGrokBillingFromHost(input.host) : undefined) ??
    (yield* readGrokBillingOverHttp(input.environment, input.cliVersion));
  if (live) {
    if (input.cachePath)
      yield* writeCachedGrokUsageLimits(input.cachePath, live).pipe(
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );
    return live;
  }
  const cached = input.cachePath
    ? yield* readCachedGrokUsageLimits(input.cachePath).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  if (cached) return cached;
  return {
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    windows: [],
    unavailable: {
      reason: "probeFailed",
      message:
        "Grok didn't report limits. Run `grok login` on this Cogenly server host if you haven't, then refresh.",
    },
  } satisfies ServerProviderUsageLimits;
});
