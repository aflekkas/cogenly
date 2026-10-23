import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";

/**
 * A Cogenly-managed integration: one upstream MCP server every provider
 * reaches through the single `cogenly` endpoint via three generic tools
 * (list, tools, call). Definitions are environment state today and become
 * shared documents when sync lands; credentials never live here, only
 * `{{credential:<vault item>.<field>}}` references in header templates.
 */

export const IntegrationId = TrimmedNonEmptyString.pipe(Schema.brand("IntegrationId"));
export type IntegrationId = typeof IntegrationId.Type;

/** Slug agents and settings use to name an integration. */
export const IntegrationName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-_]*$/),
);
export type IntegrationName = typeof IntegrationName.Type;

/** `http` is the only transport in v1; `stdio` joins this union later. */
export const IntegrationTransport = Schema.Literals(["http"]);
export type IntegrationTransport = typeof IntegrationTransport.Type;

/** All projects, or only the listed project folders (by label id). */
export const IntegrationScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all") }),
  Schema.Struct({
    type: Schema.Literal("projects"),
    labelIds: Schema.Array(ProjectLabelId).check(Schema.isMaxLength(100)),
  }),
]);
export type IntegrationScope = typeof IntegrationScope.Type;

/** Header name -> template; values may embed `{{credential:item.field}}`. */
export const IntegrationHeaders = Schema.Record(
  Schema.String.check(Schema.isMaxLength(200)),
  Schema.String.check(Schema.isMaxLength(4000)),
);
export type IntegrationHeaders = typeof IntegrationHeaders.Type;

const integrationFields = {
  name: IntegrationName,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  transport: IntegrationTransport,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  headers: IntegrationHeaders,
  enabled: Schema.Boolean,
  scope: IntegrationScope,
  /** Short hint agents see next to the name, e.g. "Gmail for aflekkas@…". */
  hint: Schema.String.check(Schema.isMaxLength(500)),
};

export const Integration = Schema.Struct({
  id: IntegrationId,
  ...integrationFields,
  /** Credential destination authorized by the owner; absent on legacy definitions. */
  credentialOrigin: Schema.optional(Schema.String),
  /**
   * Vault item names the owner approved for `credentialOrigin`. Any other item
   * resolves only when its allowed domains include the integration's host.
   */
  approvedCredentialItems: Schema.optional(Schema.Array(Schema.String)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Tombstone; null while live. Deletes set this instead of removing the row. */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Integration = typeof Integration.Type;

export const IntegrationCreateInput = Schema.Struct({
  ...integrationFields,
  enabled: Schema.optional(Schema.Boolean),
});
export type IntegrationCreateInput = typeof IntegrationCreateInput.Type;

export const IntegrationUpdateInput = Schema.Struct({
  id: IntegrationId,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  transport: Schema.optional(IntegrationTransport),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  headers: Schema.optional(IntegrationHeaders),
  enabled: Schema.optional(Schema.Boolean),
  scope: Schema.optional(IntegrationScope),
  hint: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type IntegrationUpdateInput = typeof IntegrationUpdateInput.Type;

export const IntegrationKey = Schema.Struct({ id: IntegrationId });
export type IntegrationKey = typeof IntegrationKey.Type;

export const IntegrationConnectionStatus = Schema.Literals([
  "connected",
  "disconnected",
  "unknown",
]);
export type IntegrationConnectionStatus = typeof IntegrationConnectionStatus.Type;

/** What clients and `integrations_list` see: never resolved credentials, and literal header values masked. */
export const IntegrationSummary = Schema.Struct({
  integration: Integration,
  status: IntegrationConnectionStatus,
  toolCount: Schema.NullOr(Schema.Number),
});
export type IntegrationSummary = typeof IntegrationSummary.Type;

export const IntegrationListResult = Schema.Struct({
  integrations: Schema.Array(IntegrationSummary),
});
export type IntegrationListResult = typeof IntegrationListResult.Type;

export const IntegrationMutationResult = Schema.Struct({ integration: Integration });
export type IntegrationMutationResult = typeof IntegrationMutationResult.Type;

export const IntegrationDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type IntegrationDeleteResult = typeof IntegrationDeleteResult.Type;

export const IntegrationTestResult = Schema.Struct({
  status: IntegrationConnectionStatus,
  toolCount: Schema.Number,
  message: Schema.String,
});
export type IntegrationTestResult = typeof IntegrationTestResult.Type;

export class IntegrationError extends Schema.TaggedError<IntegrationError>()("IntegrationError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "storage",
    "not_found",
    "conflict",
    "disabled",
    "credential_unresolved",
    "credential_not_allowed",
    "upstream_unreachable",
    "upstream_timeout",
    "upstream_error",
    "invalid_request",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not ${this.operation} integration (${this.reason}).`;
  }
}
export const isIntegrationError = Schema.is(IntegrationError);

/** MCP-facing shapes for the generic gateway tools. */
export const IntegrationByNameInput = Schema.Struct({ name: IntegrationName });
export type IntegrationByNameInput = typeof IntegrationByNameInput.Type;

export const IntegrationToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Unknown,
});
export type IntegrationToolInfo = typeof IntegrationToolInfo.Type;

export const IntegrationToolsResult = Schema.Struct({
  name: IntegrationName,
  tools: Schema.Array(IntegrationToolInfo),
});
export type IntegrationToolsResult = typeof IntegrationToolsResult.Type;

export const IntegrationCallInput = Schema.Struct({
  name: IntegrationName,
  tool: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  arguments: Schema.optional(Schema.Unknown),
});
export type IntegrationCallInput = typeof IntegrationCallInput.Type;

/** The upstream tool result, passed through without credential material. */
export const IntegrationCallResult = Schema.Struct({
  content: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
});
export type IntegrationCallResult = typeof IntegrationCallResult.Type;

export const IntegrationUpdateByNameInput = Schema.Struct({
  name: IntegrationName,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  transport: Schema.optional(IntegrationTransport),
  url: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  headers: Schema.optional(IntegrationHeaders),
  enabled: Schema.optional(Schema.Boolean),
  scope: Schema.optional(IntegrationScope),
  hint: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type IntegrationUpdateByNameInput = typeof IntegrationUpdateByNameInput.Type;

export const IntegrationRemoveInput = Schema.Struct({ name: IntegrationName });
export type IntegrationRemoveInput = typeof IntegrationRemoveInput.Type;
