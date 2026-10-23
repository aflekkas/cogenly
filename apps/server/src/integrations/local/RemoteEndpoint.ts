import { IntegrationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/http";
import { makePinnedFetch } from "../../outboundHttp.ts";
import { publicAddresses } from "../../security/PublicAddress.ts";

const publicFetch = (raw: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(raw),
      catch: () =>
        new IntegrationError({ operation: "validate endpoint", reason: "invalid_request" }),
    });
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return yield* new IntegrationError({
        operation: "validate endpoint",
        reason: "invalid_request",
      });
    const addresses = yield* Effect.promise(() => publicAddresses(url.hostname));
    if (!addresses)
      return yield* new IntegrationError({
        operation: "reach public MCP endpoint",
        reason: "invalid_request",
      });
    return (yield* Effect.acquireRelease(
      Effect.sync(() => makePinnedFetch(addresses)),
      ({ close }) => Effect.promise(close),
    )).fetch;
  });

/** Tests replace the network boundary; production always pins every remote request to public DNS answers. */
export const IntegrationEndpointPolicy = Context.Reference<
  (url: string) => Effect.Effect<typeof globalThis.fetch | undefined, IntegrationError, Scope.Scope>
>("cogenly-server/integrations/IntegrationEndpointPolicy", { defaultValue: () => publicFetch });

export const withPublicEndpoint = <A, E, R>(url: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const policy = yield* IntegrationEndpointPolicy;
      const fetch = yield* policy(url);
      return yield* fetch
        ? effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
        : effect;
    }),
  );
