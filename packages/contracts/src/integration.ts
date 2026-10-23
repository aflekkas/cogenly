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

/**
 * OAuth sign-in to the upstream server (MCP authorization spec). Tokens live
 * in the vault, never here. `clientId` and `clientSecret` are for servers
 * without dynamic client registration (e.g. a Slack app the owner created);
 * the secret is a `{{credential:<item>.<field>}}` reference, never a value.
 */
export const IntegrationAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  clientSecret: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Space-separated scopes to ask for; defaults to what the server advertises. */
  scope: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
});
export type IntegrationAuth = typeof IntegrationAuth.Type;

/** Which connection of a provider this is, e.g. "Spawn Partners" or "personal". */
const IntegrationAccountLabel = Schema.String.check(Schema.isMaxLength(200));

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
  accountLabel: Schema.optional(IntegrationAccountLabel),
  auth: Schema.optional(IntegrationAuth),
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
  /** An empty label removes it. */
  accountLabel: Schema.optional(IntegrationAccountLabel),
  /** Null turns OAuth sign-in off and forgets the stored tokens. */
  auth: Schema.optional(Schema.NullOr(IntegrationAuth)),
});
export type IntegrationUpdateInput = typeof IntegrationUpdateInput.Type;

export const IntegrationKey = Schema.Struct({ id: IntegrationId });
export type IntegrationKey = typeof IntegrationKey.Type;

/**
 * `needs_sign_in`: OAuth has no usable grant (never signed in, or revoked).
 * `error`: the last check failed; `message` says why.
 */
export const IntegrationConnectionStatus = Schema.Literals([
  "connected",
  "disconnected",
  "unknown",
  "needs_sign_in",
  "error",
]);
export type IntegrationConnectionStatus = typeof IntegrationConnectionStatus.Type;

/** What clients and `integrations_list` see: never resolved credentials, and literal header values masked. */
export const IntegrationSummary = Schema.Struct({
  integration: Integration,
  status: IntegrationConnectionStatus,
  toolCount: Schema.NullOr(Schema.Number),
  message: Schema.optional(Schema.String),
  checkedAt: Schema.optional(IsoDateTime),
});
export type IntegrationSummary = typeof IntegrationSummary.Type;

export const IntegrationListResult = Schema.Struct({
  integrations: Schema.Array(IntegrationSummary),
});
export type IntegrationListResult = typeof IntegrationListResult.Type;

/** A browser link that starts OAuth sign-in; it returns to `redirectUri` on this server. */
export const IntegrationSignIn = Schema.Struct({
  authorizationUrl: Schema.String,
  redirectUri: Schema.String,
});
export type IntegrationSignIn = typeof IntegrationSignIn.Type;

export const IntegrationMutationResult = Schema.Struct({
  integration: Integration,
  /** Present when the integration needs a browser sign-in before agents can use it. */
  signIn: Schema.optional(IntegrationSignIn),
});
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
    "approval_required",
    "sign_in_required",
    /** The server has no dynamic client registration; the owner must supply a client id. */
    "client_id_required",
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
  accountLabel: Schema.optional(IntegrationAccountLabel),
  auth: Schema.optional(Schema.NullOr(IntegrationAuth)),
});
export type IntegrationUpdateByNameInput = typeof IntegrationUpdateByNameInput.Type;

export const IntegrationRemoveInput = Schema.Struct({ name: IntegrationName });
export type IntegrationRemoveInput = typeof IntegrationRemoveInput.Type;
