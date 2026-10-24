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
export const IntegrationTransport = Schema.Literals(["http", "local", "stdio"]);
export type IntegrationTransport = typeof IntegrationTransport.Type;

/** The account is the integration's `accountLabel`, as for remote integrations. */
export const LocalIntegrationConfig = Schema.Struct({
  preset: Schema.Literal("google-workspace"),
  version: TrimmedNonEmptyString,
  callbackOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type LocalIntegrationConfig = typeof LocalIntegrationConfig.Type;

/** A server-owned stdio process. Secret environment values are vault references. */
export const IntegrationCommand = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4000))).check(Schema.isMaxLength(100)),
  env: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4000))),
});
export type IntegrationCommand = typeof IntegrationCommand.Type;

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
  command: Schema.optional(IntegrationCommand),
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
  apiKey: IntegrationCatalogInputs.fields.apiKey,
  clientId: IntegrationCatalogInputs.fields.clientId,
  clientSecret: IntegrationCatalogInputs.fields.clientSecret,
  preset: Schema.optional(GoogleWorkspaceAddInput.fields.preset),
  name: Schema.optional(IntegrationName),
  displayName: Schema.optional(integrationFields.displayName),
  transport: Schema.optional(IntegrationTransport),
  local: integrationFields.local,
  command: integrationFields.command,
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
  command: Schema.optional(IntegrationCommand),
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

/** A definition that arrived from another machine, set by machine sync. */
export const IntegrationSyncedFrom = Schema.Struct({
  machineLabel: Schema.String.check(Schema.isMaxLength(200)),
});
export type IntegrationSyncedFrom = typeof IntegrationSyncedFrom.Type;

/** One step of a guided setup, in plain words, with where to do it and what to paste. */
export const IntegrationSetupStep = Schema.Struct({
  text: Schema.String,
  /** The exact console page for this step. */
  url: Schema.optional(Schema.String),
  /** A value to copy into the service, such as the redirect URI or the scopes. */
  copy: Schema.optional(Schema.Struct({ label: Schema.String, value: Schema.String })),
});
export type IntegrationSetupStep = typeof IntegrationSetupStep.Type;

const setupActionBase = {
  /** A short heading, e.g. "Sign in to Linear". */
  title: Schema.String,
  /** One or two plain sentences on what is wrong or missing. */
  message: Schema.String,
  /** The account this is for; absent before one exists. */
  integrationId: Schema.optional(IntegrationId),
  catalogId: Schema.optional(IntegrationCatalogId),
};

/**
 * The one next thing a person (or an agent, through Settings) does to make an
 * integration usable. Settings renders it inline on the row; agents get the
 * same action in plain words with a Settings link.
 *
 * - `sign_in`: one click, `integrations.beginSignIn`.
 * - `oauth_client`: create an app with the service by following `steps`, then
 *   enter its client id and secret (`integrations.saveOAuthClient`).
 * - `api_key`: create a key or token at `url`, then enter it (`integrations.saveApiKey`).
 * - `install_runtime`: a program Cogenly runs is missing; `integrations.installRuntime`
 *   when `canInstall`, otherwise `command` by hand.
 * - `retry`: something failed that may pass on its own; `button` says which control retries.
 * - `fix`: the definition needs a change; `button` says which control fixes it.
 */
export const IntegrationSetupAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("sign_in"), ...setupActionBase }),
  Schema.Struct({
    type: Schema.Literal("oauth_client"),
    ...setupActionBase,
    steps: Schema.Array(IntegrationSetupStep),
  }),
  Schema.Struct({
    type: Schema.Literal("api_key"),
    ...setupActionBase,
    /** What the service calls it, e.g. "Personal access token". */
    label: Schema.String,
    /** Where to create one. */
    url: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("install_runtime"),
    ...setupActionBase,
    runtime: Schema.Literal("uv"),
    canInstall: Schema.Boolean,
    /** The command a person runs instead, e.g. `brew install uv`. */
    command: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    ...setupActionBase,
    button: Schema.Literals(["test", "sign_in"]),
  }),
  Schema.Struct({
    type: Schema.Literal("fix"),
    ...setupActionBase,
    button: Schema.Literals(["edit", "enable"]),
  }),
]);
export type IntegrationSetupAction = typeof IntegrationSetupAction.Type;

/** What clients and `integrations_list` see: never resolved credentials, and literal header values masked. */
export const IntegrationSummary = Schema.Struct({
  integration: Integration,
  status: IntegrationConnectionStatus,
  toolCount: Schema.NullOr(Schema.Number),
  message: Schema.optional(Schema.String),
  /** The next action for an account that is not connected: needs sign-in or an error. */
  setup: Schema.optional(IntegrationSetupAction),
  syncedFrom: Schema.optional(IntegrationSyncedFrom),
  checkedAt: Schema.optional(IsoDateTime),
  callbackHost: Schema.optional(Schema.String),
  /** The process behind a `local` integration, which Cogenly runs. */
  managed: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["starting", "running", "failed", "missing_runtime", "stopped"]),
      version: Schema.String,
      /** Failed-process diagnostics, returned only by an explicit owner Settings read. */
      stderrTail: Schema.optional(Schema.String),
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

/**
 * Connecting from the catalog, or saving its credentials: the integration
 * (absent when nothing could be created yet), its sign-in link, or the next
 * action when something has to happen first.
 */
export const IntegrationConnectResult = Schema.Struct({
  integration: Schema.optional(Integration),
  signIn: Schema.optional(IntegrationSignIn),
  setup: Schema.optional(IntegrationSetupAction),
});
export type IntegrationConnectResult = typeof IntegrationConnectResult.Type;

const secretInputTarget = {
  catalogId: IntegrationCatalogId,
  /** The account to update; omit to connect a new one. */
  integrationId: Schema.optional(IntegrationId),
  /** Names a new account, e.g. "work"; Google needs one to connect. */
  accountLabel: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  scope: Schema.optional(IntegrationScope),
};

/**
 * An app's client id and secret, typed into Settings. The server stores the
 * secret in the vault and the integration references it; the value never
 * appears in an integration, an event or a result.
 */
const oauthClientSecretFields = {
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  clientSecret: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
};
export const IntegrationSaveOAuthClientInput = Schema.Union([
  Schema.Struct({ ...secretInputTarget, ...oauthClientSecretFields }),
  // A custom server already exists when discovery asks for a manual client.
  Schema.Struct({
    ...secretInputTarget,
    catalogId: Schema.optional(IntegrationCatalogId),
    integrationId: IntegrationId,
    ...oauthClientSecretFields,
  }),
]);
export type IntegrationSaveOAuthClientInput = typeof IntegrationSaveOAuthClientInput.Type;

/** An API key or token typed into Settings, stored in the vault like a client secret. */
export const IntegrationSaveApiKeyInput = Schema.Struct({
  ...secretInputTarget,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
});
export type IntegrationSaveApiKeyInput = typeof IntegrationSaveApiKeyInput.Type;

/** A program a managed integration runs; only uv (for Google's uvx) today. */
export const IntegrationRuntime = Schema.Literal("uv");
export type IntegrationRuntime = typeof IntegrationRuntime.Type;

export const IntegrationInstallRuntimeInput = Schema.Struct({ runtime: IntegrationRuntime });
export type IntegrationInstallRuntimeInput = typeof IntegrationInstallRuntimeInput.Type;

export const IntegrationInstallRuntimeResult = Schema.Struct({
  installed: Schema.Boolean,
  /** What happened, in plain words; on failure, the installer's last output lines. */
  message: Schema.String,
});
export type IntegrationInstallRuntimeResult = typeof IntegrationInstallRuntimeResult.Type;

/**
 * A connected account as the composer's Sources picker shows it: no headers,
 * no OAuth state. `name` is what `integration_call` takes; `scope` lets the
 * client keep a thread's picker to its project.
 */
export const IntegrationSource = Schema.Struct({
  id: IntegrationId,
  name: IntegrationName,
  displayName: Schema.String,
  icon: Schema.NullOr(IntegrationCatalogId),
  /** The catalog service's name, or the display name of a custom server. */
  serviceName: Schema.String,
  accountLabel: Schema.NullOr(Schema.String),
  status: Schema.Literals(["connected", "needs_sign_in", "error"]),
  message: Schema.optional(Schema.String),
  scope: IntegrationScope,
  syncedFrom: Schema.optional(IntegrationSyncedFrom),
});
export type IntegrationSource = typeof IntegrationSource.Type;

export const IntegrationSourcesResult = Schema.Struct({
  sources: Schema.Array(IntegrationSource),
});
export type IntegrationSourcesResult = typeof IntegrationSourcesResult.Type;

/**
 * `integration_add` and `integration_update` for agents: what the Settings
 * call returns, plus the next action in plain words and a Settings link the
 * user can open.
 */
export const IntegrationAgentResult = Schema.Struct({
  ...IntegrationConnectResult.fields,
  nextStep: Schema.optional(Schema.String),
  settingsUrl: Schema.optional(Schema.String),
});
export type IntegrationAgentResult = typeof IntegrationAgentResult.Type;

export const IntegrationAgentListResult = Schema.Struct({
  integrations: Schema.Array(
    Schema.Struct({
      ...IntegrationSummary.fields,
      nextStep: Schema.optional(Schema.String),
      settingsUrl: Schema.optional(Schema.String),
    }),
  ),
});
export type IntegrationAgentListResult = typeof IntegrationAgentListResult.Type;

export const IntegrationDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type IntegrationDeleteResult = typeof IntegrationDeleteResult.Type;

export const IntegrationTestResult = Schema.Struct({
  /** Server time when this test began; later subscription outcomes supersede it. */
  checkedAt: Schema.optional(IsoDateTime),
  reason: Schema.optional(Schema.String),
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
    "scope_missing",
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
  command: Schema.optional(IntegrationCommand),
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

export const IntegrationSetupGuideInput = Schema.Struct({ service: TrimmedNonEmptyString });
export const IntegrationSetupGuideResult = Schema.Struct({
  service: Schema.String,
  instructions: Schema.String,
});

export const IntegrationNativeImportPreview = Schema.Struct({
  definitions: Schema.Array(IntegrationCreateInput),
  reconnect: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type IntegrationNativeImportPreview = typeof IntegrationNativeImportPreview.Type;
export const IntegrationNativeImportResult = Schema.Struct({
  imported: Schema.Array(Schema.String),
  reconnect: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type IntegrationNativeImportResult = typeof IntegrationNativeImportResult.Type;
