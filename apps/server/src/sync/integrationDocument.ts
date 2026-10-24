import { Integration, IntegrationAuth } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A web definition contains no command, headers, client credentials or local grant. */
export const IntegrationFields = Schema.Struct({
  name: Integration.fields.name,
  displayName: Integration.fields.displayName,
  hint: Integration.fields.hint,
  transport: Schema.Literal("http"),
  url: Integration.fields.url.check(
    Schema.makeFilter((raw) => {
      try {
        const url = new URL(raw);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
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
export const integrationFields = (integration: Integration): Record<string, Schema.Json> => ({
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
});
