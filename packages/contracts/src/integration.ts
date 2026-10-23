import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IntegrationCatalogAuthKind, IntegrationCatalogId } from "./integrationCatalog.ts";
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

/** Local endpoints are allocated by Cogenly, never taken from user-entered URLs. */
export const IntegrationTransport = Schema.Literals(["http", "local"]);
export type IntegrationTransport = typeof IntegrationTransport.Type;

/** The account is the integration's `accountLabel`, as for remote integrations. */
export const LocalIntegrationConfig = Schema.Struct({
  preset: Schema.Literal("google-workspace"),
  version: TrimmedNonEmptyString,
  callbackOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type LocalIntegrationConfig = typeof LocalIntegrationConfig.Type;

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
  local: Schema.optional(LocalIntegrationConfig),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  headers: IntegrationHeaders,
  enabled: Schema.Boolean,
  scope: IntegrationScope,
  /** Short hint agents see next to the name, e.g. "Gmail for aflekkas@…". */
  hint: Schema.String.check(Schema.isMaxLength(500)),
  accountLabel: Schema.optional(IntegrationAccountLabel),
  auth: Schema.optional(IntegrationAuth),
};

export const IntegrationProvenance = Schema.Struct({
  addedByAgent: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  signedInAt: Schema.optional(IsoDateTime),
  signedInViaAgent: Schema.optional(Schema.Boolean),
});

export const Integration = Schema.Struct({
  id: IntegrationId,
  ...integrationFields,
  provenance: Schema.optional(IntegrationProvenance),
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

/** The preset supplies the package, version, command, services and vault references. */
export const GoogleWorkspaceAddInput = Schema.Struct({
  preset: Schema.Literal("google-workspace"),
  accountLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  name: Schema.optional(IntegrationName),
  callbackOrigin: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  scope: Schema.optional(IntegrationScope),
});
export type GoogleWorkspaceAddInput = typeof GoogleWorkspaceAddInput.Type;
export const IntegrationAddInput = Schema.Union([IntegrationCreateInput, GoogleWorkspaceAddInput]);
export type IntegrationAddInput = typeof IntegrationAddInput.Type;

/**
 * What a user fills in to connect a catalog entry. Secrets are
 * `{{credential:<item>.<field>}}` vault references, never values.
 */
export const IntegrationCatalogInputs = Schema.Struct({
  /** A region id, for services hosted per region (Intercom: us or eu). */
  region: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  /** The auth mode; inferred from the other inputs when omitted. */
  auth: Schema.optional(IntegrationCatalogAuthKind),
  /** Vault reference to an API key or token, sent as a bearer token. */
  apiKey: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** For a service without automatic client registration (e.g. a Slack app). */
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  /** Vault reference to that app's client secret. */
  clientSecret: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** The reachable origin for OAuth callbacks (registered with Google for its preset). */
  callbackOrigin: GoogleWorkspaceAddInput.fields.callbackOrigin,
});
export type IntegrationCatalogInputs = typeof IntegrationCatalogInputs.Type;

/** Connect one entry of the default catalog; the server fills in the rest. */
export const IntegrationCatalogConnectInput = Schema.Struct({
  catalogId: IntegrationCatalogId,
  /** Which account this is, e.g. "work"; required for Google. */
  accountLabel: Schema.optional(GoogleWorkspaceAddInput.fields.accountLabel),
  inputs: Schema.optional(IntegrationCatalogInputs),
  scope: Schema.optional(IntegrationScope),
});
export type IntegrationCatalogConnectInput = typeof IntegrationCatalogConnectInput.Type;

/**
 * `integration_add` arguments as one object, since MCP tools need an object
 * root; the handler decodes them as `IntegrationCatalogConnectInput` when
 * `catalogId` is set, otherwise as `IntegrationAddInput`.
 */
export const IntegrationAddToolInput = Schema.Struct({
  catalogId: Schema.optional(IntegrationCatalogId),
  region: IntegrationCatalogInputs.fields.region,
  apiKey: IntegrationCatalogInputs.fields.apiKey,
  clientId: IntegrationCatalogInputs.fields.clientId,
  clientSecret: IntegrationCatalogInputs.fields.clientSecret,
  preset: Schema.optional(GoogleWorkspaceAddInput.fields.preset),
  name: Schema.optional(IntegrationName),
  displayName: Schema.optional(integrationFields.displayName),
  transport: Schema.optional(IntegrationTransport),
  local: integrationFields.local,
  url: Schema.optional(integrationFields.url),
  headers: Schema.optional(IntegrationHeaders),
  enabled: Schema.optional(Schema.Boolean),
  scope: Schema.optional(IntegrationScope),
  hint: Schema.optional(integrationFields.hint),
  accountLabel: integrationFields.accountLabel,
  auth: integrationFields.auth,
  callbackOrigin: GoogleWorkspaceAddInput.fields.callbackOrigin,
});
export type IntegrationAddToolInput = typeof IntegrationAddToolInput.Type;

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
 * `needs_sign_in`: no usable grant (never signed in, or revoked), for remote
 * OAuth and managed local accounts alike. `error`: the last check failed, or a
 * managed process failed; `message` says why.
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
  /** The process behind a `local` integration, which Cogenly runs. */
  managed: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["starting", "running", "failed", "missing_runtime", "stopped"]),
      version: Schema.String,
      stderrTail: Schema.String,
      message: Schema.optional(Schema.String),
    }),
  ),
});
export type IntegrationSummary = typeof IntegrationSummary.Type;

export const IntegrationListResult = Schema.Struct({
  integrations: Schema.Array(IntegrationSummary),
});
export type IntegrationListResult = typeof IntegrationListResult.Type;

/**
 * A browser link that starts sign-in; it returns to `redirectUri` on this
 * server. Remote OAuth links go straight to the authorization server; a
 * managed local account's link is a short-lived Cogenly page that asks its
 * process for one.
 */
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
  /** Server time when this test began; later subscription outcomes supersede it. */
  checkedAt: Schema.optional(IsoDateTime),
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
    /** The Google preset needs the owner's OAuth client in the vault. */
    "google_client_missing",
    /** A managed local server's runtime (e.g. uvx) is not installed. */
    "local_runtime_missing",
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
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
export type IntegrationCallResult = typeof IntegrationCallResult.Type;

export const IntegrationUpdateByNameInput = Schema.Struct({
  name: IntegrationName,
  callbackOrigin: GoogleWorkspaceAddInput.fields.callbackOrigin,
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
