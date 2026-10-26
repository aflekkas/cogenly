import { isPublicIntegrationUrl } from "../integrations/publicEndpoint.ts";
import { Integration, IntegrationAuth } from "@cogenly/contracts";
import * as Schema from "effect/Schema";

/** Why a definition stays on this machine; never include its potentially secret URL. */
export function integrationNotSyncedReason(integration: Pick<Integration, "transport" | "url">) {
  if (integration.transport !== "http") return "Not synced: command runners are machine-local.";
  try {
    const url = new URL(integration.url);
    if (!["http:", "https:"].includes(url.protocol))
      return "Not synced: only HTTP endpoints can sync.";
    if (url.username || url.password) return "Not synced: URL contains credentials.";
    // No query parameter is documented as public across supported endpoints.
    // Keep the allowlist empty rather than guessing every vendor's secret names.
    if (url.searchParams.size > 0)
      return "Not synced: URL query parameters may contain credentials.";
    if (url.hash) return "Not synced: URL fragments may contain credentials.";
    if (!isPublicIntegrationUrl(url)) return "Not synced: URL paths may contain credentials.";
  } catch {
    return "Not synced: invalid endpoint URL.";
  }
  return undefined;
}

/** A web definition contains no command, headers, client credentials or local grant. */
export const IntegrationFields = Schema.Struct({
  name: Integration.fields.name,
  displayName: Integration.fields.displayName,
  hint: Integration.fields.hint,
  transport: Schema.Literal("http"),
  url: Integration.fields.url.check(
    Schema.makeFilter(
      (url) => integrationNotSyncedReason({ transport: "http", url }) === undefined,
    ),
  ),
  auth: Schema.NullOr(
    Schema.Struct({
      type: IntegrationAuth.fields.type,
      scope: IntegrationAuth.fields.scope,
    }),
  ),
  scope: Integration.fields.scope,
  enabled: Integration.fields.enabled,
  createdAt: Integration.fields.createdAt,
});
export type IntegrationFields = typeof IntegrationFields.Type;
export const decodeIntegrationFields = Schema.decodeUnknownOption(IntegrationFields);

/** Always pick explicitly: a new credential field must never travel by default. */
export const integrationFields = (
  integration: Integration,
): Record<string, Schema.Json> | undefined =>
  integrationNotSyncedReason(integration) === undefined
    ? {
        name: integration.name,
        displayName: integration.displayName,
        hint: integration.hint,
        transport: "http",
        url: integration.url,
        auth:
          integration.auth === undefined
            ? null
            : {
                type: integration.auth.type,
                ...(integration.auth.scope === undefined ? {} : { scope: integration.auth.scope }),
              },
        scope: integration.scope,
        enabled: integration.enabled,
        createdAt: integration.createdAt,
      }
    : undefined;
