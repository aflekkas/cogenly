import { isPublicIntegrationPath } from "../integrations/publicEndpoint.ts";
import { Integration, IntegrationAuth, integrationCatalogEntryFor } from "@cogenly/contracts";
import { parseCredentialRef } from "../integrations/IntegrationCredentials.ts";
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
    if (!isPublicIntegrationPath(url.pathname) && !integrationCatalogEntryFor(integration))
      return "Not synced: URL paths may contain credentials.";
  } catch {
    return "Not synced: invalid endpoint URL.";
  }
  return undefined;
}

/** Templates contain vault references and protocol prefixes, never literal credentials. */
const headerTemplate = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value === "" ||
      (/^(?:Bearer |Basic )?(?:\{\{credential:[^{}]+\}\})+$/.test(value) &&
        [...value.matchAll(/\{\{credential:([^{}]+)\}\}/g)].every(
          (match) => parseCredentialRef(match[1]!) !== undefined,
        )),
  ),
);
const reference = Schema.String.check(
  Schema.makeFilter((value) => parseCredentialRef(value) !== undefined),
);

/** Public definitions carry references; values travel only through encrypted vault sync. */
export const IntegrationFields = Schema.Struct({
  icon: Integration.fields.icon,
  iconUrl: Integration.fields.iconUrl,
  accountLabel: Integration.fields.accountLabel,
  headers: Schema.optional(Schema.Record(Schema.String, headerTemplate)),
  endpointRef: Schema.optional(Schema.NullOr(reference)),
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
      clientId: IntegrationAuth.fields.clientId,
      clientSecret: Schema.optional(headerTemplate),
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
        ...(integration.icon === undefined ? {} : { icon: integration.icon }),
        ...(integration.iconUrl === undefined ? {} : { iconUrl: integration.iconUrl }),
        accountLabel: integration.accountLabel ?? "",
        headers: Object.fromEntries(
          Object.entries(integration.headers).filter(([, value]) =>
            Schema.is(headerTemplate)(value),
          ),
        ),
        endpointRef: integration.endpointRef ?? null,
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
                ...(integration.auth.clientId === undefined
                  ? {}
                  : { clientId: integration.auth.clientId }),
                ...(integration.auth.clientSecret === undefined ||
                !Schema.is(headerTemplate)(integration.auth.clientSecret)
                  ? {}
                  : { clientSecret: integration.auth.clientSecret }),
              },
        scope: integration.scope,
        enabled: integration.enabled,
        createdAt: integration.createdAt,
      }
    : undefined;
