import { IntegrationError } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";

export interface SignInOrigin {
  readonly origin: string | undefined;
  readonly fromAgent?: boolean;
  /** A reachable browser origin, supplied explicitly by an agent. */
  readonly callbackOrigin?: string | undefined;
}

/** Use a proven browser origin for loopback agent requests, scoped to this account. */
export const selectCallbackOrigin = (from: SignInOrigin, known?: string) => {
  const requested = from.origin === undefined ? null : URL.parse(from.origin);
  const candidate =
    from.callbackOrigin ??
    (from.fromAgent && (requested === null || isLoopbackHost(requested.hostname))
      ? known
      : requested?.origin);
  const parsed = candidate === undefined ? null : URL.parse(candidate);
  return parsed !== null &&
    !parsed.username &&
    !parsed.password &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (from.callbackOrigin === undefined || parsed.origin === from.callbackOrigin)
    ? Effect.succeed(parsed.origin)
    : Effect.fail(
        new IntegrationError({
          operation: "start sign-in",
          reason: "invalid_request",
          cause:
            "Open Settings → Integrations on the VPS's reachable address and sign in there first, or pass callbackOrigin with that HTTPS origin. A loopback agent request cannot discover the browser's public address.",
        }),
      );
};
