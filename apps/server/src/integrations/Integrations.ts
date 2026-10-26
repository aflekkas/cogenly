import { isPublicIntegrationPath } from "./publicEndpoint.ts";
import * as NativeImport from "./NativeIntegrationImport.ts";
import {
  Integration,
  IntegrationError,
  IntegrationId,
  integrationCatalogEntry,
  integrationCatalogEntryFor,
  integrationIcon,
  INTEGRATION_CATALOG,
  type IntegrationNativeImportPreview,
  type IntegrationNativeImportResult,
  type IntegrationCallResult,
  type IntegrationAddInput,
  type IntegrationCatalogConnectInput,
  type IntegrationConnectResult,
  type IntegrationInstallRuntimeResult,
  type IntegrationMutationResult,
  type IntegrationListResult,
  type IntegrationName,
  type IntegrationRuntime,
  type IntegrationSaveApiKeyInput,
  type IntegrationSaveOAuthClientInput,
  type IntegrationSignIn,
  type IntegrationSource,
  type IntegrationSourcesResult,
  type IntegrationSummary,
  type IntegrationTestResult,
  type IntegrationToolsResult,
  type IntegrationUpdateInput,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { integrationSetupGuide } from "./IntegrationSetupGuides.ts";
import { redactUpstream, toolErrorMessage, upstreamErrorMessage } from "./UpstreamResult.ts";
import { selectCallbackOrigin, type SignInOrigin } from "./SignInOrigin.ts";
import { hostMatchesAnyDomain } from "../vault/VaultPolicy.ts";
import { redactValue } from "../vault/VaultRedactor.ts";
import { catalogIntegrationName, resolveCatalogConnect } from "./IntegrationCatalog.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import { GOOGLE_CLIENT_ITEM, catalogSetupFor, setupActionFor } from "./IntegrationSetup.ts";
import * as Installer from "./local/RuntimeInstaller.ts";
import * as OAuth from "./IntegrationOAuth.ts";
import { IntegrationSyncPeers } from "./IntegrationSyncPeers.ts";
import * as Tokens from "./IntegrationTokens.ts";
import { StoredIntegration } from "./StoredIntegration.ts";
import { OAuthState } from "./StoredIntegration.ts";
import * as IntegrationSync from "../sync/IntegrationSync.ts";
import { integrationNotSyncedReason } from "../sync/integrationDocument.ts";
import * as Local from "./local/LocalIntegrations.ts";
import { GOOGLE_WORKSPACE_VERSION } from "./local/GoogleWorkspace.ts";
import { IntegrationEndpointPolicy, withPublicEndpoint } from "./RemoteEndpoint.ts";

const oauthStateKey = Schema.encodeSync(Schema.fromJsonString(OAuthState));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredIntegration));
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredIntegration));
const isError = Schema.is(IntegrationError);
const failure =
  (operation: string, reason: IntegrationError["reason"]) =>
  (cause: unknown): IntegrationError =>
    isError(cause) ? cause : new IntegrationError({ operation, reason, cause });

export const DEFAULT_TOOL_CACHE_TTL_MS = 60_000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024;
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

const CREDENTIAL_REF = /\{\{credential:([^}]*)\}\}/g;

/** Credential references referenced by a header template, in order. */
export const credentialRefsIn = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(CREDENTIAL_REF)].map((match) => (match[1] ?? "").trim());

/**
 * The vault item names a set of headers and an OAuth client secret reference,
 * which an owner approves together.
 */
const credentialItemsIn = (
  headers: Readonly<Record<string, string>>,
  auth?: Integration["auth"],
  command?: Integration["command"],
  endpointRef?: string,
): Array<string> => [
  ...new Set(
    [
      ...Object.values(headers),
      ...Object.values(command?.env ?? {}),
      auth?.clientSecret ?? "",
      endpointRef === undefined ? "" : `{{credential:${endpointRef}}}`,
    ].flatMap((template) =>
      credentialRefsIn(template).flatMap((ref) => {
        const parsed = Credentials.parseCredentialRef(ref);
        return parsed === undefined ? [] : [parsed.item];
      }),
    ),
  ),
];

const definitionKey = Schema.encodeSync(Schema.fromJsonString(Integration));

const usesOAuth = (integration: Integration) => integration.auth?.type === "oauth";

/** The grant's destination and local authorization; cosmetic peer edits keep it. */
const grantKey = (integration: StoredIntegration) =>
  JSON.stringify({
    url: integration.url,
    auth: integration.auth,
    headers: integration.headers,
    credentialOrigin: integration.credentialOrigin,
    approvedCredentialItems: integration.approvedCredentialItems,
    oauthState: integration.oauthState,
  });

/** "Linear · Spawn Partners": how people and agents tell two accounts of one service apart. */
export const integrationTitle = (integration: Integration): string =>
  integration.accountLabel?.trim()
    ? `${integration.displayName} · ${integration.accountLabel.trim()}`
    : integration.displayName;

/**
 * What clients and agents see in place of a literal header value, which may be
 * a pasted secret. Credential templates are shown as they are. Sending the
 * mask back in an update keeps the stored value.
 */
export const HEADER_MASK = "••••";

/** Headers as clients and agents may see them. */
export const redactHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value === "" ||
      (credentialRefsIn(value).length > 0 && !value.includes("{{credential:integration-secret:"))
        ? value
        : HEADER_MASK,
    ]),
  );

/** What leaves the service: masked headers and no OAuth state. */
const redactIntegration = (integration: Integration | StoredIntegration): Integration => {
  const {
    oauthState: _,
    browserOrigin: _origin,
    syncedFrom: _synced,
    ...rest
  } = integration as StoredIntegration;
  const identity = integrationIcon(integration);
  return {
    ...rest,
    ...(identity.icon === null ? {} : { icon: identity.icon }),
    ...(identity.iconUrl === undefined ? {} : { iconUrl: identity.iconUrl }),
    headers: redactHeaders(integration.headers),
    ...(integration.command === undefined
      ? {}
      : {
          command: {
            ...integration.command,
            env: Object.fromEntries(
              Object.entries(integration.command.env).map(([key, value]) => [
                key,
                integration.command?.nonSecretEnv?.includes(key)
                  ? value
                  : redactHeaders({ value }).value!,
              ]),
            ),
          },
        }),
  };
};

/**
 * Treat every header as sensitive: even a static Host header can change
 * routing. OAuth settings are part of the destination too: a client secret
 * reference travels to whatever token endpoint the server names.
 */
export const integrationDestinationChanged = (
  current: Integration,
  input: IntegrationUpdateInput,
): boolean =>
  (input.command !== undefined &&
    JSON.stringify(input.command) !== JSON.stringify(current.command)) ||
  (input.url !== undefined && input.url !== current.url) ||
  (input.endpointRef !== undefined && (input.endpointRef ?? undefined) !== current.endpointRef) ||
  (input.transport !== undefined && input.transport !== current.transport) ||
  (input.auth !== undefined &&
    JSON.stringify(input.auth) !== JSON.stringify(current.auth ?? null)) ||
  (input.headers !== undefined &&
    (Object.keys(input.headers).length !== Object.keys(current.headers).length ||
      Object.entries(input.headers).some(
        ([name, value]) => value !== HEADER_MASK && current.headers[name] !== value,
      )));

/** An agent may only change the executable after the owner reviews the whole command. */
export const integrationExecutableChanged = (
  current: Integration,
  input: Pick<IntegrationUpdateInput, "command" | "transport">,
): boolean =>
  (input.transport === "stdio" && current.transport !== "stdio") ||
  (input.command !== undefined &&
    JSON.stringify(input.command) !== JSON.stringify(current.command));

/** Account labels identify the signed-in account; agents need approval to change them. */
export const integrationAccountLabelChanged = (
  current: Integration,
  input: Pick<IntegrationUpdateInput, "accountLabel">,
): boolean =>
  input.accountLabel !== undefined &&
  input.accountLabel.trim() !== (current.accountLabel?.trim() ?? "");

/**
 * Whether `headers` would still send a secret the caller never saw: a stored
 * literal value kept as it was (sent back masked, or left out of the update),
 * or any vault credential reference.
 */
export const headersKeepStoredSecrets = (
  current: Integration,
  headers: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(headers).some(
    ([name, value]) =>
      value !== "" && (credentialRefsIn(value).length > 0 || current.headers[name] === value),
  );

/** Adding any project, or switching to all projects, needs owner approval. */
export const integrationScopeWidened = (
  current: Integration,
  input: IntegrationUpdateInput,
): boolean =>
  input.scope !== undefined &&
  current.scope.type !== "all" &&
  (input.scope.type === "all" ||
    input.scope.labelIds.some(
      (id) => current.scope.type === "projects" && !current.scope.labelIds.includes(id),
    ));

/**
 * Resolves `{{credential:item.field}}` references in every header value.
 * Fails closed: an unknown template, a malformed reference, or a missing
 * credential fails the whole resolution and no headers are produced.
 */
export const resolveHeaderTemplates = (
  headers: Readonly<Record<string, string>>,
  resolve: (
    ref: string,
  ) => Effect.Effect<
    Option.Option<string>,
    Credentials.IntegrationCredentialError | Credentials.IntegrationCredentialNotAllowedError
  >,
): Effect.Effect<Record<string, string>, IntegrationError> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, template] of Object.entries(headers)) {
      if (template.includes("{{") && credentialRefsIn(template).length === 0) {
        return yield* new IntegrationError({
          operation: "resolve credentials",
          reason: "credential_unresolved",
        });
      }
      let value = template;
      for (const ref of credentialRefsIn(template)) {
        if (Credentials.parseCredentialRef(ref) === undefined) {
          return yield* new IntegrationError({
            operation: "resolve credentials",
            reason: "credential_unresolved",
          });
        }
        const secret = yield* resolve(ref).pipe(
          Effect.mapError(
            (error) =>
              new IntegrationError({
                operation: "resolve credentials",
                reason:
                  error._tag === "IntegrationCredentialNotAllowedError"
                    ? "credential_not_allowed"
                    : "credential_unresolved",
              }),
          ),
        );
        if (Option.isNone(secret)) {
          return yield* new IntegrationError({
            operation: "resolve credentials",
            reason: "credential_unresolved",
          });
        }
        value = value.replaceAll(`{{credential:${ref}}}`, () => secret.value);
      }
      resolved[name] = value;
    }
    return resolved;
  });

/**
 * Whether an integration is usable from a project. `null` means the caller
 * has no project (only all-project integrations), a label id scopes to that
 * project, and `undefined` means an unrestricted owner view (settings, MCP
 * clients signed in from outside a thread).
 */
export const integrationVisibleTo = (
  integration: Integration,
  labelId: ProjectLabelId | null | undefined,
): boolean =>
  integration.deletedAt === null &&
  integration.enabled &&
  (labelId === undefined ||
    integration.scope.type === "all" ||
    (labelId !== null && integration.scope.labelIds.includes(labelId)));

interface CachedTools {
  readonly key: string;
  readonly atMs: number;
  readonly result: IntegrationToolsResult;
}

/**
 * How a write was authorized. The owner's own writes (Settings, or approving
 * an agent's proposal) approve the vault items in the headers for the
 * integration's origin; any other write approves nothing.
 */
export interface IntegrationWriteOptions {
  readonly approveCredentials?: boolean;
  readonly approveExecutable?: boolean;
  readonly fromAgent?: boolean | undefined;
  readonly ownerOrigin?: string | undefined;
  readonly addedByAgent?: { readonly id: string; readonly name: string } | undefined;
  readonly callerLabelId?: ProjectLabelId | null | undefined;
  readonly preserveScope?: boolean;
}

export interface IntegrationsOptions {
  readonly toolCacheTtlMs?: number;
  readonly upstreamTimeoutMs?: number;
}

/** What the browser brings back to the callback. */
export interface SignInCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
  readonly iss: string | undefined;
}

/** A pending sign-in lives this long, and only this many at once. */
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGN_INS = 64;
/** Refresh at most this long before the access token expires. */
const REFRESH_SKEW_MS = 60_000;

/**
 * The operation of a `sign_in_required` error that is not this machine's to
 * fix: another machine refreshes the shared sign-in. Its cause is the message.
 */
export const REFRESH_WAIT_OPERATION = "wait for another machine to refresh";

/** The message for an error raised while another machine owns the refresh, if it is one. */
export const refreshWaitMessage = (error: IntegrationError): string | undefined =>
  error.operation === REFRESH_WAIT_OPERATION && typeof error.cause === "string"
    ? error.cause
    : undefined;

/**
 * When a token issued at `issuedAtMs` is due a refresh: a minute before it
 * expires, or halfway through a lifetime shorter than two minutes, so a
 * short-lived token is not refreshed on every call. Null when it never expires.
 */
export function tokenRefreshAt(expiresAt: number | null, issuedAtMs: number | null): number | null {
  if (expiresAt === null) return null;
  const lifetime = issuedAtMs === null ? Infinity : Math.max(0, expiresAt - issuedAtMs);
  return expiresAt - Math.min(REFRESH_SKEW_MS, lifetime / 2);
}

export class Integrations extends Context.Service<
  Integrations,
  {
    readonly previewNative: () => Effect.Effect<IntegrationNativeImportPreview, IntegrationError>;
    readonly importNative: () => Effect.Effect<IntegrationNativeImportResult, IntegrationError>;
    readonly setupGuide: (
      service: string,
    ) => Effect.Effect<ReturnType<typeof integrationSetupGuide>>;
    /** Every live integration, unscoped (settings/client view). */
    readonly list: (options?: {
      readonly includeProcessOutput?: boolean;
    }) => Effect.Effect<IntegrationListResult, IntegrationError>;
    /** Live integrations usable from one project (null = no project). */
    readonly listForProject: (
      labelId: ProjectLabelId | null,
    ) => Effect.Effect<IntegrationListResult, IntegrationError>;
    readonly create: (
      input: IntegrationAddInput,
      options?: IntegrationWriteOptions,
    ) => Effect.Effect<IntegrationMutationResult, IntegrationError>;
    /**
     * A changed origin drops every credential approval unless this write approves anew.
     * `holdStoredSecrets` (every agent write) refuses a destination change that would
     * carry stored literal headers or vault credentials along; the owner makes it in Settings.
     */
    readonly update: (
      input: IntegrationUpdateInput,
      options?: IntegrationWriteOptions & {
        readonly preserveCredentialDestination?: boolean;
        readonly holdStoredSecrets?: boolean;
      },
    ) => Effect.Effect<IntegrationMutationResult, IntegrationError>;
    /** Tombstones the integration; its name becomes reusable. */
    readonly remove: (
      id: IntegrationId,
      options?: IntegrationWriteOptions,
    ) => Effect.Effect<{ deleted: boolean }, IntegrationError>;
    readonly testConnection: (
      id: IntegrationId,
      labelId?: ProjectLabelId | null,
    ) => Effect.Effect<IntegrationTestResult, IntegrationError>;
    readonly listTools: (
      name: IntegrationName,
      labelId: ProjectLabelId | null | undefined,
    ) => Effect.Effect<IntegrationToolsResult, IntegrationError>;
    readonly callTool: (
      name: IntegrationName,
      tool: string,
      args: unknown,
      labelId: ProjectLabelId | null | undefined,
    ) => Effect.Effect<IntegrationCallResult, IntegrationError>;
    /** Scoped account health, including disabled definitions so catalog entries stay reserved. */
    readonly contextIntegrations: (
      labelId: ProjectLabelId | null,
    ) => Effect.Effect<
      ReadonlyArray<Integration & { readonly status: IntegrationSummary["status"] | "disabled" }>,
      IntegrationError
    >;
    /** The owner's list, then again after every change. */
    readonly subscribe: () => Stream.Stream<IntegrationListResult, IntegrationError>;
    /**
     * Starts OAuth sign-in for an integration: discovers its authorization
     * server, registers a client when it can, and returns the link to open.
     */
    readonly beginSignIn: (
      id: IntegrationId,
      origin: SignInOrigin,
    ) => Effect.Effect<IntegrationSignIn, IntegrationError>;
    /** Finishes a sign-in from the browser callback; a state it did not issue fails. */
    readonly completeSignIn: (
      callback: SignInCallback,
    ) => Effect.Effect<{ integration: Integration }, IntegrationError>;
    /**
     * Connects a default catalog entry (a remote service or the Google preset)
     * under an unused name, and starts its sign-in when it has one. When a key,
     * the owner's app or Google's client is missing, nothing is created and the
     * result is the setup action instead. A sign-in that cannot start leaves
     * the integration saved, with the action that unblocks it. Any other
     * missing input fails `invalid_request` with the next step as its cause.
     */
    readonly connectFromCatalog: (
      input: IntegrationCatalogConnectInput,
      options: IntegrationWriteOptions & { readonly origin: SignInOrigin },
    ) => Effect.Effect<IntegrationConnectResult, IntegrationError>;
    /**
     * An account's sign-in link when it needs one and one can start, otherwise
     * the action that unblocks it (a missing runtime, client or key). Agents
     * get links only for accounts that never signed in.
     */
    readonly prepareSignIn: (
      id: IntegrationId,
      origin: SignInOrigin,
    ) => Effect.Effect<IntegrationConnectResult, IntegrationError>;
    /**
     * Stores an app's client secret in the vault (Google's shared client as
     * `google-oauth-client`, any other as `<name>-client-secret`), points the
     * account at it, and connects or signs in. The secret never leaves the vault.
     */
    readonly saveOAuthClient: (
      input: IntegrationSaveOAuthClientInput,
      options: { readonly origin: SignInOrigin },
    ) => Effect.Effect<IntegrationConnectResult, IntegrationError>;
    /** Stores an API key as `<name>-api-key` and sends it as the account's bearer token. */
    readonly saveApiKey: (
      input: IntegrationSaveApiKeyInput,
      options: { readonly origin: SignInOrigin },
    ) => Effect.Effect<IntegrationConnectResult, IntegrationError>;
    /** Installs a runtime a managed account needs; accounts waiting on it start on the next list. */
    readonly installRuntime: (
      runtime: IntegrationRuntime,
    ) => Effect.Effect<IntegrationInstallRuntimeResult, IntegrationError>;
    /** Enabled accounts for the composer's Sources picker, again whenever one changes. */
    readonly subscribeSources: () => Stream.Stream<IntegrationSourcesResult, IntegrationError>;
    /**
     * Signs in web (non-local) OAuth integrations from sign-ins that arrived
     * through vault sync: one that is not signed in here, or whose token item
     * is gone, takes the newest synced item naming its id, when the item's
     * allowed domains cover the integration's host. A signed-in integration
     * whose item was removed or emptied needs sign-in again. Runs after vault
     * sync changes an item, at startup, and on create; call it after writing
     * an integration definition another way, e.g. projecting a synced one.
     * Never changes `updatedAt`. `integrationId` limits it to one integration.
     */
    readonly adoptSyncedSignIns: (
      integrationId?: IntegrationId,
    ) => Effect.Effect<void, IntegrationError>;
    /**
     * Scheduler only: while the vault is shared, refreshes sign-ins this
     * machine owns the refresh of shortly before they expire, so the new
     * tokens reach every machine before any of them needs them.
     */
    readonly refreshSharedSignIns: Effect.Effect<void>;
  }
>()("cogenly-server/integrations/Integrations") {}

/** One account as the Sources picker shows it; not yet usable reads as needs sign-in or error. */
export const integrationSource = (summary: IntegrationSummary): IntegrationSource => {
  const { integration } = summary;
  const entry = integrationCatalogEntryFor(integration);
  const status =
    summary.status === "needs_sign_in"
      ? ("needs_sign_in" as const)
      : summary.status === "error" || summary.status === "disconnected"
        ? ("error" as const)
        : ("connected" as const);
  const message = status === "connected" ? undefined : (summary.message ?? summary.setup?.title);
  return {
    id: integration.id,
    name: integration.name,
    displayName: integration.displayName,
    ...integrationIcon(integration),
    serviceName: entry?.name ?? integration.displayName,
    accountLabel: integration.accountLabel?.trim() || null,
    status,
    ...(message === undefined ? {} : { message }),
    scope: integration.scope,
    ...(summary.syncedFrom === undefined ? {} : { syncedFrom: summary.syncedFrom }),
  };
};

const remoteRedirectUri = (origin: string | undefined) => {
  const parsed = origin === undefined ? null : URL.parse(origin);
  return parsed === null ? undefined : `${parsed.origin}${OAuth.CALLBACK_PATH}`;
};

const RpcEnvelope = {
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
};
const JsonRpcResponse = Schema.Union([
  Schema.Struct({ ...RpcEnvelope, result: Schema.Unknown, error: Schema.optional(Schema.Never) }),
  Schema.Struct({
    ...RpcEnvelope,
    result: Schema.optional(Schema.Never),
    error: Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  }),
]);
type JsonRpcResponse = typeof JsonRpcResponse.Type;
const decodeRpcBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));

const parseRpcBody = (text: string): JsonRpcResponse | undefined => {
  const trimmed = text.trim();
  const candidates = [trimmed];
  let data: Array<string> = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length > 0) candidates.push(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length > 0) candidates.push(data.join("\n"));
  for (const candidate of candidates.toReversed()) {
    const parsed = decodeRpcBody(candidate);
    if (Option.isSome(parsed)) return parsed.value;
  }
  return undefined;
};

const CHECK_MESSAGES: Partial<Record<IntegrationError["reason"], string>> = {
  credential_unresolved: "A vault reference could not be resolved.",
  credential_not_allowed: "A vault item isn't allowed for this server.",
  upstream_unreachable: "The server could not be reached.",
  upstream_timeout: "The server took too long to answer.",
  upstream_error: "The server answered with an error.",
  sign_in_required: "Sign in again.",
  scope_missing:
    "The grant is missing a required scope. Reconnect to approve the required permissions.",
  client_id_required: "This server needs a client ID from an app you create with the provider.",
};

/** Status text owners and agents see; upstream messages are already bounded. */
const checkMessage = (error: IntegrationError): string => {
  const waiting = refreshWaitMessage(error);
  if (waiting !== undefined) return waiting;
  const { reason, cause } = error;
  const base = CHECK_MESSAGES[reason] ?? "The request could not be completed.";
  return (reason === "upstream_error" || reason === "scope_missing") &&
    typeof cause === "string" &&
    cause.trim() !== ""
    ? `${base} ${cause.trim().slice(0, MAX_UPSTREAM_MESSAGE_CHARS)}`
    : base;
};

/** The non-secret half of a sign-in, as it travels with the token item. */
const signInAttachment = (
  integration: Integration,
  state: {
    readonly server: OAuth.OAuthServer;
    readonly registration: OAuth.OAuthClientRegistration | undefined;
    readonly expiresAt: number | null;
    readonly refreshAt?: number | null | undefined;
    readonly refreshOwner: string;
  },
): Tokens.SignInAttachment => ({
  kind: "integration-oauth",
  v: 1,
  integrationId: integration.id,
  authorization: {
    url: integration.url,
    scope: integration.scope,
    ...(integration.auth?.scope === undefined ? {} : { oauthScope: integration.auth.scope }),
    ...(integration.auth?.clientId === undefined ? {} : { clientId: integration.auth.clientId }),
  },
  server: state.server,
  ...(state.registration === undefined ? {} : { registration: state.registration }),
  expiresAt: state.expiresAt,
  refreshAt: state.refreshAt ?? tokenRefreshAt(state.expiresAt, null),
  refreshOwner: state.refreshOwner,
});

/**
 * Whether a synced sign-in item may sign `integration` in on this machine: it
 * names the integration, still holds a usable grant, may be sent to the
 * integration's host, and uses the kind of client the definition does.
 */
const adoptable = (
  integration: StoredIntegration,
  signIn: Tokens.AttachedSignIn,
  nowMs: number,
  alreadySignedIn = false,
): boolean => {
  const { attachment } = signIn;
  const authorization = attachment.authorization;
  if (
    authorization === undefined ||
    authorization.url !== integration.url ||
    authorization.oauthScope !== integration.auth?.scope ||
    (authorization.clientId !== integration.auth?.clientId &&
      !(
        alreadySignedIn &&
        authorization.clientId === undefined &&
        attachment.registration === undefined
      ))
  )
    return false;
  if (
    authorization.scope.type !== "all" &&
    (integration.scope.type === "all" ||
      integration.scope.labelIds.some(
        (id) =>
          authorization.scope.type === "projects" && !authorization.scope.labelIds.includes(id),
      ))
  )
    return false;
  if (attachment.integrationId !== integration.id || !signIn.hasAccessToken) return false;
  if (!signIn.hasRefreshToken && attachment.expiresAt !== null && attachment.expiresAt <= nowMs)
    return false;
  const host = Option.liftThrowable(() => new URL(integration.url).hostname)();
  if (Option.isNone(host) || !hostMatchesAnyDomain(host.value, signIn.item.allowedDomains))
    return false;
  // A configured client id signs in without a registration; otherwise the registration is the client.
  return (integration.auth?.clientId === undefined) === (attachment.registration !== undefined);
};

/** One vault item per integration account, named by its id so renames never collide. */
const tokenItemName = (integration: Integration) =>
  `integration-oauth:${integration.id.replace(/^integration:/, "")}`;

const make = (options: IntegrationsOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sync = yield* Effect.serviceOption(IntegrationSync.IntegrationSync);
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials.IntegrationCredentials;
    const tokenStore = yield* Tokens.IntegrationTokens;
    const peers = yield* IntegrationSyncPeers;
    const protocol = yield* OAuth.make;
    const nativeImport = yield* Effect.serviceOption(NativeImport.NativeIntegrationImport);
    const local = yield* Effect.serviceOption(Local.LocalIntegrations);
    // Settings' secret forms and the uv installer; absent in suites that do not use them.
    const secretWriter = yield* Effect.serviceOption(Credentials.IntegrationSecrets);
    const installer = yield* Effect.serviceOption(Installer.RuntimeInstaller);
    const endpointPolicy = yield* IntegrationEndpointPolicy;
    const ttlMs = options.toolCacheTtlMs ?? DEFAULT_TOOL_CACHE_TTL_MS;
    const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const cache = yield* Ref.make(new Map<string, CachedTools>());
    const requestIds = yield* Ref.make(0);
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const changes = yield* PubSub.unbounded<void>();
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    /** The last upstream outcome per integration version, for the status column. */
    const checks = yield* Ref.make(
      new Map<
        IntegrationId,
        {
          readonly updatedAt: string;
          readonly ok: boolean;
          readonly message?: string;
          readonly reason?: IntegrationError["reason"];
          readonly checkedAt: string;
        }
      >(),
    );
    /** Sign-ins waiting for their browser callback, by `state`. Lost on restart; the user retries. */
    const pendingSignIns = yield* Ref.make(
      new Map<
        string,
        {
          readonly integrationId: IntegrationId;
          readonly fromAgent: boolean;
          readonly url: string;
          readonly definition: string;
          readonly server: OAuth.OAuthServer;
          readonly redirectUri: string;
          readonly verifier: string;
          readonly registration: OAuth.OAuthClientRegistration | undefined;
          /** A secret issued by a registration made for this sign-in, until it is stored. */
          readonly newClientSecret: string | undefined;
          readonly expiresAtMs: number;
        }
      >(),
    );
    /**
     * Decrypted tokens per signed-in integration, so calls do not reopen the
     * vault. An entry is good while its item's revision stays the same; a
     * refresh on another machine arrives as a new revision.
     */
    const liveTokens = new Map<
      IntegrationId,
      Tokens.StoredTokens & {
        readonly itemId: string;
        readonly revision: number;
        readonly expiresAt: number | null;
        readonly refreshOwner: string;
        readonly server: OAuth.OAuthServer | undefined;
        readonly registration: OAuth.OAuthClientRegistration | undefined;
        readonly refreshAt: number | null;
      }
    >();
    /** One adoption pass at a time; each is idempotent. */
    const adoptPermit = yield* Semaphore.make(1);
    /** One refresh at a time per account; waiters reuse the token it produced. */
    const integrationLocks = new Map<IntegrationId, Semaphore.Semaphore>();
    const integrationLock = (id: IntegrationId) => {
      let lock = integrationLocks.get(id);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        integrationLocks.set(id, lock);
      }
      return lock;
    };

    const invalidate = (id: IntegrationId) =>
      Ref.update(cache, (entries) => {
        const next = new Map(entries);
        for (const key of next.keys()) if (key.startsWith(`${id}:`)) next.delete(key);
        return next;
      });

    /** Stores a secret typed into Settings; the failure carries no cause, so no value can leak. */
    const saveSecret = (
      input: Credentials.IntegrationSecretInput,
    ): Effect.Effect<void, IntegrationError> =>
      Option.isNone(secretWriter)
        ? Effect.fail(new IntegrationError({ operation: "save secret", reason: "storage" }))
        : secretWriter.value
            .save(input)
            .pipe(
              Effect.mapError(
                () => new IntegrationError({ operation: "save secret", reason: "storage" }),
              ),
            );

    /** Private paths are capabilities: keep the endpoint in the vault, even for direct creates. */
    const protectEndpoint = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        if (integration.transport !== "http") return integration;
        const url = new URL(integration.url);
        if (
          url.username ||
          url.password ||
          url.hash ||
          (url.search && integration.auth !== undefined)
        )
          return integration;
        if (
          !url.search &&
          (isPublicIntegrationPath(url.pathname) || integrationCatalogEntryFor(integration))
        )
          return integration;
        const item = `integration-endpoint:${integration.id.replace(/^integration:/, "")}`;
        yield* saveSecret({
          item,
          type: "api_key",
          fields: { value: integration.url },
          domains: [url.hostname],
          label: `${integration.displayName} private endpoint`,
        });
        return { ...integration, url: `${url.origin}/`, endpointRef: `${item}.value` };
      });

    /** Encrypt literal pieces, retaining only known protocol prefixes alongside credential refs. */
    const protectLiterals = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        const domains = [
          integration.transport === "stdio" ? "localhost" : new URL(integration.url).hostname,
        ];
        const protect = (value: string, header: boolean) =>
          Effect.gen(function* () {
            if (value === "") return value;
            const matches = [...value.matchAll(CREDENTIAL_REF)];
            const literal = (part: string) =>
              Effect.gen(function* () {
                if (
                  part === "" ||
                  (header && matches.length > 0 && ["Bearer ", "Basic "].includes(part))
                )
                  return part;
                const item = `integration-secret:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure("save secret", "storage")))}`;
                yield* saveSecret({
                  item,
                  type: "api_key",
                  fields: { value: part },
                  domains,
                  label: `${integration.displayName} credential`,
                });
                return `{{credential:${item}.value}}`;
              });
            let result = "";
            let offset = 0;
            for (const match of matches) {
              result += (yield* literal(value.slice(offset, match.index))) + match[0];
              offset = match.index + match[0].length;
            }
            return result + (yield* literal(value.slice(offset)));
          });
        const headers = Object.fromEntries(
          yield* Effect.forEach(Object.entries(integration.headers), ([key, value]) =>
            protect(value, true).pipe(Effect.map((value) => [key, value] as const)),
          ),
        );
        const command = integration.command;
        return {
          ...integration,
          headers,
          ...(command === undefined
            ? {}
            : {
                command: {
                  ...command,
                  env: Object.fromEntries(
                    yield* Effect.forEach(Object.entries(command.env), ([key, value]) =>
                      (command.nonSecretEnv?.includes(key)
                        ? Effect.succeed(value)
                        : protect(value, false)
                      ).pipe(Effect.map((value) => [key, value] as const)),
                    ),
                  ),
                },
              }),
        };
      });

    /** Upgrade legacy plaintext rows on startup and on reads, including old writers and tombstones. */
    const readStored = (payload: string) =>
      Effect.gen(function* () {
        const current = yield* decode(payload).pipe(Effect.mapError(failure("read", "storage")));
        let repaired = current;
        const catalogEndpoint =
          current.transport === "http" && current.endpointRef !== undefined
            ? INTEGRATION_CATALOG.find(
                (entry) =>
                  entry.kind === "remote" &&
                  new URL(entry.url).origin === new URL(current.url).origin,
              )
            : undefined;
        if (catalogEndpoint?.kind === "remote" && current.endpointRef !== undefined) {
          // Older versions vaulted even public catalog paths (notably Wispr's /v1/mcp).
          // Restore only an exact catalog endpoint, never infer a credential destination.
          const endpoint = yield* credentials
            .resolve(current.endpointRef, {
              host: new URL(current.url).hostname,
              approvedItems: [],
            })
            .pipe(Effect.orElseSucceed(() => Option.none<string>()));
          if (Option.isSome(endpoint) && endpoint.value === catalogEndpoint.url) {
            const { endpointRef: _, ...rest } = current;
            repaired = { ...rest, url: catalogEndpoint.url, icon: catalogEndpoint.icon };
          }
        }
        const identity = integrationIcon(repaired);
        const withIcon = {
          ...repaired,
          ...(identity.icon === null ? {} : { icon: identity.icon }),
        };
        const protectedValue = yield* protectLiterals(yield* protectEndpoint(withIcon));
        const encoded = yield* encode(protectedValue).pipe(
          Effect.mapError(failure("write", "storage")),
        );
        if (
          encoded !== (yield* encode(current).pipe(Effect.mapError(failure("read", "storage"))))
        ) {
          yield* sql`UPDATE integrations SET payload_json=${encoded} WHERE id=${current.id} AND payload_json=${payload}`.pipe(
            Effect.mapError(failure("write", "storage")),
          );
          if (Option.isSome(sync))
            yield* sync.value
              .publish(protectedValue, current)
              .pipe(Effect.mapError(failure("upgrade definition", "storage")));
        }
        return protectedValue;
      }).pipe(sql.withTransaction, Effect.mapError(failure("migrate credentials", "storage")));

    const rows = () =>
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE deleted_at IS NULL ORDER BY name`.pipe(
        Effect.flatMap((found) => Effect.forEach(found, (row) => readStored(row.payload_json))),
        Effect.mapError(failure("list", "storage")),
      );

    const getById = (id: IntegrationId) =>
      Effect.gen(function* () {
        const found = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM integrations WHERE id = ${id} AND deleted_at IS NULL`.pipe(
          Effect.mapError(failure("read", "storage")),
        );
        if (!found[0]) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        return yield* readStored(found[0].payload_json);
      });

    const getByName = (name: IntegrationName, labelId: ProjectLabelId | null | undefined) =>
      Effect.gen(function* () {
        const all = yield* rows();
        const found = all.find((integration) => integration.name === name);
        if (found === undefined) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        if (!found.enabled) {
          return yield* new IntegrationError({ operation: "read", reason: "disabled" });
        }
        if (!integrationVisibleTo(found, labelId)) {
          return yield* new IntegrationError({ operation: "read", reason: "not_found" });
        }
        return found;
      });

    /**
     * Managed process health and grant state. Status reads retry failed Google
     * starts but leave idle processes stopped; only use or sign-in wakes them.
     */
    const managedState = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        if (
          !["local", "stdio"].includes(integration.transport) ||
          !integration.enabled ||
          Option.isNone(local)
        )
          return undefined;
        let process = yield* local.value.status(integration.id);
        if (
          integration.transport === "local" &&
          (process?.state === "missing_runtime" || process?.state === "failed")
        ) {
          yield* local.value.start(integration).pipe(Effect.ignore);
          process = yield* local.value.status(integration.id);
        }
        if (process === undefined) {
          if (integration.transport !== "local") return undefined;
          const signedIn = yield* local.value
            .signedIn(integration.id)
            .pipe(Effect.orElseSucceed(() => false));
          const check = (yield* Ref.get(checks)).get(integration.id);
          return {
            process: undefined,
            status: !signedIn
              ? ("needs_sign_in" as const)
              : check?.updatedAt === integration.updatedAt && !check.ok
                ? ("error" as const)
                : ("connected" as const),
          };
        }
        const signedIn =
          integration.transport === "stdio" ||
          (yield* local.value.signedIn(integration.id).pipe(Effect.orElseSucceed(() => false)));
        const check = (yield* Ref.get(checks)).get(integration.id);
        const status: IntegrationSummary["status"] =
          process.state === "failed" || process.state === "missing_runtime"
            ? "error"
            : process.state === "stopped"
              ? "disconnected"
              : !signedIn
                ? "needs_sign_in"
                : process.state === "starting"
                  ? "unknown"
                  : check?.updatedAt === integration.updatedAt && !check.ok
                    ? "error"
                    : "connected";
        return { process, status };
      });

    const runtimePlan = (
      runtime: IntegrationRuntime,
    ): Effect.Effect<{ readonly canInstall: boolean; readonly command: string }> =>
      Option.isSome(installer)
        ? installer.value.plan(runtime)
        : Effect.succeed({ canInstall: false, command: "brew install uv" });

    /** The redirect URI the account's app must accept, when this server knows its address. */
    const redirectUriFor = (integration: StoredIntegration): Effect.Effect<string | undefined> =>
      integration.transport === "local"
        ? Option.isSome(local)
          ? local.value.redirectUri(integration)
          : Effect.succeed(undefined)
        : Effect.succeed(remoteRedirectUri(integration.browserOrigin));

    /** The setup action for an account that is not usable, from its status and last failure. */
    const setupFor = (
      integration: StoredIntegration,
      status: IntegrationSummary["status"],
      failure: { readonly reason?: IntegrationError["reason"]; readonly message?: string },
    ) =>
      Effect.gen(function* () {
        if (status !== "needs_sign_in" && status !== "error") return undefined;
        return setupActionFor({
          entry: integrationCatalogEntryFor(integration),
          integration,
          status,
          reason: failure.reason,
          message: failure.message,
          redirectUri: yield* redirectUriFor(integration),
          runtime:
            failure.reason === "local_runtime_missing" ? yield* runtimePlan("uv") : undefined,
          syncedFrom: integration.syncedFrom,
        });
      });

    const localSignIn = (integration: StoredIntegration): StoredIntegration => {
      const entry = integrationCatalogEntryFor(integration);
      const needsCredentials = usesOAuth(integration) || entry?.kind === "remote";
      if (
        needsCredentials &&
        !integration.oauthState?.signedIn &&
        Object.keys(integration.headers).length === 0
      )
        return integration;
      const { syncedFrom: _, ...rest } = integration;
      return rest;
    };

    const summaries = (
      integrations: ReadonlyArray<StoredIntegration>,
      includeProcessOutput = false,
    ) =>
      Effect.gen(function* () {
        const entries = yield* Ref.get(cache);
        const checked = yield* Ref.get(checks);
        return {
          integrations: yield* Effect.forEach(integrations, (stored) =>
            Effect.gen(function* () {
              const integration = localSignIn(stored);
              const prefix = `${integration.id}:${integration.updatedAt}`;
              const cached =
                entries.get(prefix) ??
                [...entries.values()].find((entry) => entry.key.startsWith(`${prefix}:`));
              const check = checked.get(integration.id);
              const current = check?.updatedAt === integration.updatedAt ? check : undefined;
              const failed = current !== undefined && !current.ok;
              const managed = yield* managedState(integration);
              const status: IntegrationSummary["status"] =
                managed !== undefined
                  ? managed.status
                  : (usesOAuth(integration) && !integration.oauthState?.signedIn) ||
                      integration.syncedFrom !== undefined
                    ? "needs_sign_in"
                    : failed
                      ? "error"
                      : cached === undefined
                        ? "unknown"
                        : "connected";
              const message =
                (managed?.status === "error" ? managed.process?.message : undefined) ??
                current?.message;
              const localProvenance =
                integration.transport === "local" && Option.isSome(local)
                  ? yield* local.value.signInProvenance(integration.id)
                  : undefined;
              const failureReason =
                managed === undefined
                  ? failed
                    ? current?.reason
                    : undefined
                  : managed.process?.state === "missing_runtime"
                    ? ("local_runtime_missing" as const)
                    : managed.status === "error"
                      ? (managed.process?.reason ?? current?.reason)
                      : undefined;
              const setup = yield* setupFor(integration, status, {
                ...(failureReason === undefined ? {} : { reason: failureReason }),
                ...(message === undefined ? {} : { message }),
              });
              const notSyncedReason = integrationNotSyncedReason(integration);
              return {
                ...(notSyncedReason === undefined ? {} : { notSyncedReason }),
                integration: redactIntegration({
                  ...integration,
                  ...(localProvenance === undefined
                    ? {}
                    : { provenance: { ...integration.provenance, ...localProvenance } }),
                }),
                status,
                toolCount: status === "connected" && cached ? cached.result.tools.length : null,
                ...(message === undefined ? {} : { message }),
                ...(setup === undefined ? {} : { setup }),
                ...(integration.syncedFrom === undefined
                  ? {}
                  : { syncedFrom: integration.syncedFrom }),
                ...(current === undefined ? {} : { checkedAt: current.checkedAt as never }),
                ...(managed?.process === undefined
                  ? {}
                  : {
                      managed: {
                        state: managed.process.state,
                        version: managed.process.version,
                        ...(managed.process.message === undefined
                          ? {}
                          : { message: managed.process.message }),
                        ...(includeProcessOutput &&
                        managed.process.state === "failed" &&
                        managed.process.stderrTail
                          ? { stderrTail: managed.process.stderrTail }
                          : {}),
                      },
                    }),
                ...(integration.transport === "local" && Option.isSome(local)
                  ? { callbackHost: yield* local.value.callbackHost(integration) }
                  : {}),
              } satisfies IntegrationSummary;
            }),
          ),
        };
      });

    /** Records an upstream outcome; clients hear only when the status changes. */
    const recordCheck = (integration: Integration, outcome: { ok: true } | IntegrationError) =>
      Effect.gen(function* () {
        const message = "ok" in outcome ? undefined : checkMessage(outcome);
        const checkedAt = yield* now;
        const previous = yield* Ref.getAndUpdate(checks, (current) =>
          new Map(current).set(integration.id, {
            updatedAt: integration.updatedAt,
            ok: "ok" in outcome,
            ...(message === undefined ? {} : { message }),
            ...("ok" in outcome ? {} : { reason: outcome.reason }),
            checkedAt,
          }),
        );
        const before = previous.get(integration.id);
        if (
          before?.updatedAt !== integration.updatedAt ||
          before.ok !== "ok" in outcome ||
          before.message !== message
        )
          yield* notify;
      });

    const persistState = (
      id: IntegrationId,
      expected: StoredIntegration,
      update: (state: OAuthState | undefined) => OAuthState,
      browserOrigin?: string,
      signIn?: { readonly signedInAt: string; readonly signedInViaAgent: boolean },
    ) =>
      Effect.gen(function* () {
        const current = yield* getById(id);
        // Peer materialization does not take this service's lock. Check and
        // commit in one SQL transaction so an in-flight refresh or sign-in
        // cannot reattach its grant to a changed or deleted definition.
        if (grantKey(current) !== grantKey(expected))
          return yield* new IntegrationError({
            operation: "commit sign in",
            reason: "invalid_request",
          });
        // Sign-in state is not an edit: updatedAt, and so the tool cache, stay put.
        yield* persist({
          ...current,
          oauthState: update(current.oauthState),
          ...(signIn === undefined ? {} : { provenance: { ...current.provenance, ...signIn } }),
          ...(browserOrigin === undefined ? {} : { browserOrigin }),
        });
        return current;
      }).pipe(sql.withTransaction, Effect.mapError(failure("sign in", "storage")));

    /** The grant is gone; only a new browser sign-in helps, so nothing retries it. */
    const markNeedsSignIn = (integration: StoredIntegration, message: string) =>
      Effect.gen(function* () {
        liveTokens.delete(integration.id);
        yield* persistState(integration.id, integration, (state) => ({
          ...state,
          signedIn: false,
        }));
        const checkedAt = yield* now;
        yield* Ref.update(checks, (current) =>
          new Map(current).set(integration.id, {
            updatedAt: integration.updatedAt,
            ok: false,
            message,
            reason: "sign_in_required",
            checkedAt,
          }),
        );
        yield* notify;
      }).pipe(Effect.ignore);

    /**
     * The grant itself is dead (revoked, or expired with nothing to refresh
     * it): needs sign-in here, and its tokens are emptied so every machine
     * sharing the item stops using it too. The client secret stays for the
     * next sign-in.
     */
    const retireGrant = (integration: StoredIntegration, message: string) =>
      Effect.gen(function* () {
        yield* markNeedsSignIn(integration, message);
        const itemId = integration.oauthState?.tokenItemId;
        if (itemId !== undefined) yield* tokenStore.clearGrant(itemId).pipe(Effect.ignore);
      });

    const signInRequired = (operation: string) =>
      new IntegrationError({ operation, reason: "sign_in_required" });

    /** Another machine refreshes this grant; this one waits for the tokens it syncs. */
    const waitForRefreshOwner = (owner: string) =>
      Effect.gen(function* () {
        return yield* new IntegrationError({
          operation: REFRESH_WAIT_OPERATION,
          reason: "sign_in_required",
          cause: `Waiting for ${yield* peers.label(owner)} to refresh this sign-in.`,
        });
      });

    /** Forgets an account's tokens, e.g. after its server or client changed. */
    const dropTokens = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        liveTokens.delete(integration.id);
        if (integration.oauthState?.tokenItemId !== undefined)
          yield* tokenStore.remove(integration.oauthState.tokenItemId);
      });

    const loadTokens = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        const state = integration.oauthState;
        if (!state?.signedIn || state.tokenItemId === undefined) return undefined;
        const live = liveTokens.get(integration.id);
        if (live !== undefined && live.itemId === state.tokenItemId) {
          const revision = yield* tokenStore.revision(state.tokenItemId);
          if (Option.isSome(revision) && revision.value === live.revision) return live;
        }
        const stored = yield* tokenStore.read(state.tokenItemId);
        if (Option.isNone(stored)) {
          liveTokens.delete(integration.id);
          return undefined;
        }
        // The attachment travels with the tokens, so its expiry and refresh owner are theirs.
        const attachment =
          stored.value.attachment?.integrationId === integration.id
            ? stored.value.attachment
            : undefined;
        const loaded = {
          ...stored.value.tokens,
          itemId: state.tokenItemId,
          revision: stored.value.revision,
          server: attachment?.server ?? state.server,
          registration: attachment === undefined ? state.registration : attachment.registration,
          expiresAt: attachment === undefined ? (state.expiresAt ?? null) : attachment.expiresAt,
          refreshOwner: attachment?.refreshOwner ?? state.refreshOwner ?? peers.self,
          refreshAt:
            attachment === undefined
              ? (state.refreshAt ?? tokenRefreshAt(state.expiresAt ?? null, null))
              : (attachment.refreshAt ?? tokenRefreshAt(attachment.expiresAt, null)),
        };
        liveTokens.set(integration.id, loaded);
        return loaded;
      });

    /** The client a token request authenticates as. */
    /** Discovery cannot change a reviewed destination, even within the same host. */
    const authorizeOAuthServer = (integration: StoredIntegration, server: OAuth.OAuthServer) => {
      const expected = integration.auth?.server ?? integration.oauthState?.server;
      const endpoint = new URL(integration.url);
      const catalog = integrationCatalogEntryFor(integration);
      const origin =
        catalog?.kind === "remote" && catalog.tokenHost !== undefined
          ? `https://${catalog.tokenHost}`
          : endpoint.origin;
      const allowed =
        expected !== undefined
          ? expected.issuer === server.issuer &&
            expected.authorizationEndpoint === server.authorizationEndpoint &&
            expected.tokenEndpoint === server.tokenEndpoint
          : !integration.auth?.clientSecret ||
            (new URL(server.authorizationEndpoint).origin === origin &&
              new URL(server.tokenEndpoint).origin === origin);
      return allowed
        ? Effect.void
        : Effect.fail(
            new IntegrationError({
              operation: "approve OAuth server",
              reason: "approval_required",
            }),
          );
    };

    const oauthClient = (
      integration: StoredIntegration,
      server: OAuth.OAuthServer,
      registration: OAuth.OAuthClientRegistration | undefined,
      registeredSecret: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* authorizeOAuthServer(integration, server);
        const auth = integration.auth;
        if (auth?.clientId !== undefined) {
          const template = auth.clientSecret?.trim() ?? "";
          if (template === "") return { clientId: auth.clientId, authMethod: "none" as const };
          const resolved = yield* resolveHeaderTemplates({ secret: template }, (ref) =>
            credentials.resolve(ref, {
              host: new URL(server.tokenEndpoint).hostname,
              // Resource-origin approval never authorizes a client secret at an auth server.
              approvedItems: [],
            }),
          );
          return {
            clientId: auth.clientId,
            clientSecret: resolved.secret,
            authMethod: OAuth.secretAuthMethod(server),
          };
        }
        if (registration === undefined) return yield* signInRequired("sign in");
        return {
          clientId: registration.clientId,
          clientSecret: registeredSecret,
          authMethod: registration.authMethod,
        };
      });

    /**
     * A usable access token. Refreshes when it is about to expire, or when the
     * server just refused `rejected`. One refresh per account at a time: a
     * caller that waited finds the token the refresh produced and uses it.
     * Only the grant's refresh owner refreshes. Servers that rotate refresh
     * tokens revoke the whole grant when an old one is reused, so a second
     * refresher would sign the owner out everywhere; any other machine uses
     * the synced token while it is valid, then waits for the owner's next one.
     */
    const accessToken = (
      id: IntegrationId,
      rejected?: string,
      repair = true,
    ): Effect.Effect<string, IntegrationError> =>
      Effect.gen(function* () {
        const integration = yield* getById(id);
        const live = yield* loadTokens(integration);
        if (live?.server === undefined) {
          if (integration.oauthState?.signedIn)
            yield* markNeedsSignIn(integration, "Sign in again.");
          return yield* signInRequired("authorize");
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const expired = live.expiresAt !== null && live.expiresAt <= nowMs;
        const expiring = live.refreshAt !== null && live.refreshAt <= nowMs;
        if (live.refreshOwner !== peers.self) {
          if (live.accessToken !== rejected && !expired) return live.accessToken;
          // Nothing can renew a grant without a refresh token, so waiting would never end.
          if (live.refreshToken === undefined) {
            yield* markNeedsSignIn(integration, "The sign-in expired. Sign in again.");
            return yield* signInRequired("authorize");
          }
          return yield* waitForRefreshOwner(live.refreshOwner);
        }
        if (live.accessToken !== rejected && !expiring) return live.accessToken;
        if (live.refreshToken === undefined) {
          if (live.accessToken !== rejected && !expired) return live.accessToken;
          yield* retireGrant(integration, "The sign-in expired. Sign in again.");
          return yield* signInRequired("authorize");
        }
        const oauth = yield* oauthClient(
          integration,
          live.server,
          live.registration,
          live.clientSecret,
        );
        const refreshed = yield* protocol
          .refresh({
            server: live.server,
            client: oauth,
            refreshToken: live.refreshToken,
            nowMs,
          })
          .pipe(Effect.result);
        if (refreshed._tag === "Failure") {
          // A peer can replace this grant while the token request is in flight.
          // Retry once with that row's client; an old refusal cannot revoke its replacement.
          const revision = yield* tokenStore.revision(live.itemId);
          if (repair && Option.isSome(revision) && revision.value !== live.revision) {
            liveTokens.delete(id);
            return yield* accessToken(id, rejected, false);
          }
          if (refreshed.failure.revoked) {
            yield* retireGrant(integration, "The sign-in was revoked or expired. Sign in again.");
            return yield* signInRequired("refresh");
          }
          return yield* new IntegrationError({
            operation: "refresh",
            reason: "upstream_error",
            cause: refreshed.failure.message,
          });
        }
        const tokens = refreshed.success;
        const refreshAt = tokenRefreshAt(tokens.expiresAt, nowMs);
        // Through the vault, the new tokens reseal and reach every machine sharing it.
        const written = yield* tokenStore.write({
          itemId: live.itemId,
          name: tokenItemName(integration),
          label: `${integrationTitle(integration)} sign-in`,
          host: new URL(integration.url).hostname,
          tokens: { ...tokens, clientSecret: live.clientSecret },
          attachment: signInAttachment(integration, {
            server: live.server,
            registration: live.registration,
            expiresAt: tokens.expiresAt,
            refreshAt,
            refreshOwner: live.refreshOwner,
          }),
        });
        const committed = yield* persistState(id, integration, (current) => ({
          ...current,
          signedIn: true,
          tokenItemId: written.itemId,
          expiresAt: tokens.expiresAt,
          refreshOwner: live.refreshOwner,
          refreshAt,
        })).pipe(
          Effect.tapError(() =>
            dropTokens({
              ...integration,
              oauthState: {
                ...integration.oauthState,
                signedIn: false,
                tokenItemId: written.itemId,
              },
            }),
          ),
        );
        liveTokens.set(id, {
          ...tokens,
          clientSecret: live.clientSecret,
          itemId: written.itemId,
          revision: written.revision,
          server: live.server,
          registration: live.registration,
          expiresAt: tokens.expiresAt,
          refreshOwner: live.refreshOwner,
          refreshAt,
        });
        if (!committed.enabled)
          return yield* new IntegrationError({ operation: "authorize", reason: "disabled" });
        return tokens.accessToken;
      });

    /**
     * Refreshes a sign-in this machine owns the refresh of but has no
     * integration for yet, e.g. a spoke's sign-in on a hub its definition has
     * not reached. Only a registered client can: a configured client's secret
     * lives with the definition.
     */
    const refreshDetached = (signIn: Tokens.AttachedSignIn) =>
      Effect.gen(function* () {
        const stored = yield* tokenStore.read(signIn.item.id);
        if (Option.isNone(stored)) return;
        const { tokens: current, attachment } = stored.value;
        const registration = attachment?.registration;
        if (registration === undefined) return;
        const nowMs = yield* Clock.currentTimeMillis;
        if (
          attachment === undefined ||
          attachment.refreshOwner !== peers.self ||
          current.refreshToken === undefined ||
          attachment.expiresAt === null ||
          (attachment.refreshAt ?? attachment.expiresAt - REFRESH_SKEW_MS) > nowMs
        )
          return;
        const refreshed = yield* protocol
          .refresh({
            server: attachment.server,
            client: {
              clientId: registration.clientId,
              clientSecret: current.clientSecret,
              authMethod: registration.authMethod,
            },
            refreshToken: current.refreshToken,
            nowMs,
          })
          .pipe(Effect.result);
        if (refreshed._tag === "Failure") {
          if (refreshed.failure.revoked) return yield* tokenStore.clearGrant(signIn.item.id);
          return yield* new IntegrationError({
            operation: "refresh",
            reason: "upstream_error",
            cause: refreshed.failure.message,
          });
        }
        yield* tokenStore.write({
          itemId: signIn.item.id,
          name: signIn.item.name,
          label: signIn.item.label ?? signIn.item.name,
          host: signIn.item.allowedDomains[0] ?? "",
          tokens: { ...refreshed.success, clientSecret: current.clientSecret },
          attachment: {
            ...attachment,
            expiresAt: refreshed.success.expiresAt,
            refreshAt: tokenRefreshAt(refreshed.success.expiresAt, nowMs),
          },
        });
      });

    /** A streamable-HTTP JSON-RPC message to the integration, with its resolved headers. */
    const upstreamRequest = (
      integration: Integration,
      headers: Record<string, string>,
      body: unknown,
      sessionId: string | undefined,
    ) => {
      let request = HttpClientRequest.post(integration.url).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(body),
      );
      for (const [name, value] of Object.entries(headers)) {
        request = HttpClientRequest.setHeader(request, name, value);
      }
      if (sessionId !== undefined) {
        request = HttpClientRequest.setHeader(request, "mcp-session-id", sessionId);
      }
      return request;
    };

    const post = (
      integration: Integration,
      headers: Record<string, string>,
      method: string,
      params: unknown,
      sessionId: string | undefined,
    ) =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(requestIds, (value) => value + 1);
        const request = upstreamRequest(
          integration,
          headers,
          { jsonrpc: "2.0", id, method, params },
          sessionId,
        );
        const response = yield* client.execute(request).pipe(
          // Fetch otherwise forwards custom secret headers across redirects.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(
            (cause) =>
              new IntegrationError({ operation: method, reason: "upstream_unreachable", cause }),
          ),
        );
        const decoder = new TextDecoder();
        let bytes = 0;
        const text = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => "",
            (text, chunk) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_UPSTREAM_BODY_BYTES) {
                return Effect.fail(
                  new IntegrationError({ operation: method, reason: "upstream_error" }),
                );
              }
              return Effect.succeed(text + decoder.decode(chunk, { stream: true }));
            },
          ),
          Effect.map((text) => text + decoder.decode()),
          Effect.mapError(failure(method, "upstream_error")),
        );
        const live = liveTokens.get(integration.id);
        const requestSecrets = [
          ...(integration.endpointRef === undefined
            ? []
            : [integration.url, new URL(integration.url).pathname]),
          ...Object.values(headers).flatMap((value) => [
            value,
            value.replace(/^(?:Bearer|Basic)\s+/i, ""),
          ]),
          live?.accessToken ?? "",
          live?.refreshToken ?? "",
          live?.clientSecret ?? "",
        ];
        const body = parseRpcBody(text);
        const upstreamMessage = upstreamErrorMessage(text);
        const message =
          upstreamMessage === undefined
            ? undefined
            : redactUpstream(upstreamMessage, requestSecrets)
                .replace(/\s+/g, " ")
                .slice(0, MAX_UPSTREAM_MESSAGE_CHARS);
        if (response.status < 200 || response.status >= 300) {
          return yield* new IntegrationError({
            operation: method,
            // Under OAuth a 401 means the token was refused, which a refresh may fix.
            reason:
              response.status === 401
                ? "sign_in_required"
                : response.status === 403 &&
                    /insufficient_scope|scope.*(missing|required)/i.test(text)
                  ? "scope_missing"
                  : "upstream_error",
            ...(message === undefined ? {} : { cause: message }),
          });
        }
        if (body === undefined) {
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
          });
        }
        if (body.error !== undefined) {
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
            cause: message,
          });
        }
        return {
          result: redactUpstream(body.result, requestSecrets),
          sessionId: response.headers["mcp-session-id"] ?? sessionId,
        };
      }).pipe(
        (effect) =>
          withPublicEndpoint(integration.url, effect).pipe(
            Effect.provideService(IntegrationEndpointPolicy, endpointPolicy),
          ),
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              new IntegrationError({
                operation: method,
                reason: "upstream_timeout",
              }),
            ),
        }),
      );

    /**
     * One upstream round trip, with the account's OAuth token when it signs
     * in: a 401 refreshes once and retries once; a second 401 means the grant
     * is no good, and the integration needs a new sign-in. Every outcome feeds
     * the status column.
     */
    const rpc = (
      integration: StoredIntegration,
      method: string,
      params: unknown,
      labelId?: ProjectLabelId | null,
    ) =>
      Effect.gen(function* () {
        if (!usesOAuth(integration)) return yield* exchange(integration, method, params, labelId);
        const current = yield* getById(integration.id);
        if (!current.enabled || definitionKey(current) !== definitionKey(integration))
          return yield* new IntegrationError({ operation: method, reason: "invalid_request" });
        const token = yield* accessToken(integration.id);
        return yield* exchange(integration, method, params, labelId, token).pipe(
          Effect.catchIf(
            (error) => error.reason === "sign_in_required",
            () =>
              accessToken(integration.id, token).pipe(
                Effect.flatMap((fresh) =>
                  exchange(integration, method, params, labelId, fresh).pipe(
                    Effect.tapError((error) =>
                      // A machine that does not refresh this grant leaves that call to its owner.
                      error.reason === "sign_in_required" &&
                      (liveTokens.get(integration.id)?.refreshOwner ?? peers.self) === peers.self
                        ? retireGrant(integration, "The server refused the sign-in. Sign in again.")
                        : Effect.void,
                    ),
                  ),
                ),
              ),
          ),
        );
      }).pipe(
        (effect) =>
          usesOAuth(integration) ? integrationLock(integration.id).withPermits(1)(effect) : effect,
        Effect.tap((result) => {
          const message = toolErrorMessage(result);
          return recordCheck(
            integration,
            message === undefined
              ? { ok: true }
              : new IntegrationError({
                  operation: method,
                  reason: "upstream_error",
                  cause: message,
                }),
          );
        }),
        Effect.tapError((error) =>
          // A refused sign-in recorded its own, more specific status; waiting on
          // another machine's refresh is a status of its own.
          error.reason === "not_found" ||
          error.reason === "disabled" ||
          (error.reason === "sign_in_required" && refreshWaitMessage(error) === undefined)
            ? Effect.void
            : recordCheck(integration, error),
        ),
      );

    /** Resolve credentials, handshake, then call. */
    const exchange = (
      stored: Integration,
      method: string,
      params: unknown,
      labelId?: ProjectLabelId | null,
      bearer?: string,
    ) =>
      Effect.gen(function* () {
        let integration = stored;
        if (integration.transport === "local" || integration.transport === "stdio") {
          if (Option.isNone(local))
            return yield* new IntegrationError({
              operation: method,
              reason: "upstream_unreachable",
            });
          return yield* local.value.rpc(integration, method, params, labelId);
        }
        yield* validateTransport(integration);
        const endpoint = new URL(integration.url);
        if (
          integration.credentialOrigin !== undefined &&
          integration.credentialOrigin !== endpoint.origin &&
          Object.values(integration.headers).some((value) => credentialRefsIn(value).length > 0)
        ) {
          return yield* new IntegrationError({
            operation: method,
            reason: "credential_unresolved",
          });
        }
        const destination: Credentials.CredentialDestination = {
          host: endpoint.hostname,
          scopeProjectId: labelId,
          approvedItems:
            integration.credentialOrigin === endpoint.origin
              ? (integration.approvedCredentialItems ?? [])
              : [],
        };
        if (integration.endpointRef !== undefined) {
          const resolved = yield* resolveHeaderTemplates(
            { endpoint: `{{credential:${integration.endpointRef}}}` },
            (ref) => credentials.resolve(ref, destination),
          );
          const privateUrl = URL.parse(resolved.endpoint ?? "");
          if (
            !privateUrl ||
            privateUrl.origin !== endpoint.origin ||
            privateUrl.protocol !== "https:" ||
            privateUrl.username ||
            privateUrl.password ||
            privateUrl.hash
          )
            return yield* new IntegrationError({
              operation: method,
              reason: "credential_unresolved",
            });
          integration = { ...integration, url: privateUrl.href };
        }
        const resolved = yield* resolveHeaderTemplates(integration.headers, (ref) =>
          credentials.resolve(ref, destination),
        );
        // The signed-in account's token replaces any Authorization header.
        const headers =
          bearer === undefined
            ? resolved
            : {
                ...Object.fromEntries(
                  Object.entries(resolved).filter(
                    ([name]) => name.toLowerCase() !== "authorization",
                  ),
                ),
                authorization: `Bearer ${bearer}`,
              };
        const initialized = yield* post(
          integration,
          headers,
          "initialize",
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "cogenly", version: "1" },
          },
          undefined,
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        // The lifecycle requires this before any request; stateful servers refuse requests without it.
        if (initialized !== undefined) {
          yield* client
            .execute(
              upstreamRequest(
                integration,
                headers,
                { jsonrpc: "2.0", method: "notifications/initialized" },
                initialized.sessionId,
              ),
            )
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              (effect) =>
                withPublicEndpoint(integration.url, effect).pipe(
                  Effect.provideService(IntegrationEndpointPolicy, endpointPolicy),
                ),
              Effect.timeout(Duration.millis(timeoutMs)),
              Effect.ignore,
            );
        }
        return yield* post(integration, headers, method, params, initialized?.sessionId).pipe(
          Effect.map((response) => response.result),
        );
      }).pipe(
        (effect) =>
          stored.endpointRef === undefined
            ? effect
            : Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true),
        (effect) =>
          Effect.flatMap(Headers.CurrentRedactedNames, (names) =>
            Effect.provideService(effect, Headers.CurrentRedactedNames, [
              ...names,
              ...Object.keys(stored.headers).map((name) => name.toLowerCase()),
            ]),
          ),
      );

    const fetchTools = (integration: StoredIntegration, labelId?: ProjectLabelId | null) =>
      rpc(integration, "tools/list", {}, labelId).pipe(
        Effect.flatMap((result) => {
          const tools =
            typeof result === "object" && result !== null && "tools" in result
              ? (result as { tools: unknown }).tools
              : undefined;
          if (!Array.isArray(tools)) {
            return Effect.fail(
              new IntegrationError({ operation: "tools/list", reason: "upstream_error" }),
            );
          }
          return Effect.succeed({
            name: integration.name,
            tools: tools.flatMap((tool) => {
              if (typeof tool !== "object" || tool === null || !("name" in tool)) return [];
              const record = tool as Record<string, unknown>;
              return [
                {
                  name: String(record.name),
                  description: typeof record.description === "string" ? record.description : "",
                  inputSchema: record.inputSchema ?? {},
                },
              ];
            }),
          } satisfies IntegrationToolsResult);
        }),
      );

    const listTools = (
      name: IntegrationName,
      labelId: ProjectLabelId | null | undefined,
      force = false,
    ) =>
      Effect.gen(function* () {
        const integration = yield* getByName(name, labelId);
        const key = `${integration.id}:${integration.updatedAt}${labelId === undefined ? "" : labelId === null ? ":unfiled" : `:project:${labelId}`}`;
        if (!force) {
          const entries = yield* Ref.get(cache);
          const cached = entries.get(key);
          const at = yield* Clock.currentTimeMillis;
          if (cached !== undefined && at - cached.atMs < ttlMs) return cached.result;
        }
        const result = yield* fetchTools(integration, labelId);
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.update(cache, (entries) => new Map(entries).set(key, { key, atMs: at, result }));
        return result;
      });

    const validateTransport = (
      integration: Pick<Integration, "url" | "auth" | "headers" | "endpointRef" | "transport">,
    ) =>
      Effect.gen(function* () {
        const endpoint = yield* Effect.try({
          try: () => new URL(integration.url),
          catch: () =>
            new IntegrationError({ operation: "validate transport", reason: "invalid_request" }),
        });
        if (
          integration.endpointRef !== undefined &&
          (Credentials.parseCredentialRef(integration.endpointRef) === undefined ||
            integration.auth !== undefined ||
            integration.transport !== "http")
        )
          return yield* new IntegrationError({
            operation: "validate private endpoint",
            reason: "invalid_request",
          });
        if (
          (integration.endpointRef !== undefined ||
            integration.auth?.type === "oauth" ||
            Object.values(integration.headers).some((value) => value.trim() !== "")) &&
          endpoint.protocol !== "https:"
        )
          return yield* new IntegrationError({
            operation: "require HTTPS for credentials",
            reason: "invalid_request",
          });
      });

    const validateCommand = (
      input: Pick<Integration, "transport" | "command" | "auth" | "headers">,
    ) =>
      Effect.gen(function* () {
        if (input.transport !== "stdio") {
          if (input.command !== undefined)
            return yield* new IntegrationError({
              operation: "command requires stdio",
              reason: "invalid_request",
            });
          return;
        }
        if (
          !input.command ||
          input.auth !== undefined ||
          Object.keys(input.headers).length > 0 ||
          input.command.command.includes("{{") ||
          (/\s/.test(input.command.command) && !input.command.command.startsWith("/")) ||
          input.command.args.some((arg) => arg.includes("{{credential:"))
        )
          return yield* new IntegrationError({
            operation: "validate stdio command (secrets must use environment vault references)",
            reason: "invalid_request",
          });
        for (const [key, value] of Object.entries(input.command.env)) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            (value.includes("{{") &&
              credentialRefsIn(value).some(
                (ref) => Credentials.parseCredentialRef(ref) === undefined,
              ))
          )
            return yield* new IntegrationError({
              operation: "validate stdio environment",
              reason: "invalid_request",
            });
        }
      });

    const validateUrl = (url: string) =>
      Effect.try({
        try: () => new URL(url),
        catch: () => new IntegrationError({ operation: "validate", reason: "invalid_request" }),
      }).pipe(
        Effect.flatMap((parsed) =>
          parsed.protocol === "http:" || parsed.protocol === "https:"
            ? Effect.void
            : Effect.fail(
                new IntegrationError({ operation: "validate", reason: "invalid_request" }),
              ),
        ),
      );

    /** A client secret is a vault reference or nothing; never a pasted value. */
    const validateAuth = (auth: Integration["auth"] | null | undefined, operation: string) => {
      const secret = auth?.clientSecret?.trim() ?? "";
      if (secret === "") return Effect.void;
      const refs = credentialRefsIn(secret);
      return refs.length === 1 &&
        secret === `{{credential:${refs[0]}}}` &&
        Credentials.parseCredentialRef(refs[0]!) !== undefined &&
        auth?.clientId !== undefined
        ? Effect.void
        : Effect.fail(new IntegrationError({ operation, reason: "credential_unresolved" }));
    };

    const persist = (integration: StoredIntegration) =>
      encode(integration).pipe(
        Effect.flatMap(
          (payload) =>
            sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES (${integration.id}, ${integration.name}, ${payload}, ${integration.deletedAt}, ${integration.updatedAt}) ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload_json = excluded.payload_json, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
        ),
        Effect.mapError(failure("write", "storage")),
      );

    const adoptSyncedSignIns: Integrations["Service"]["adoptSyncedSignIns"] = (only) =>
      Effect.gen(function* () {
        // Local integrations sign in per machine; their sign-ins never enter the vault.
        const remote = (yield* rows()).filter(
          (integration) =>
            integration.transport !== "local" &&
            usesOAuth(integration) &&
            (only === undefined || integration.id === only),
        );
        if (remote.length === 0) return;
        // Upgrade local sign-ins before the vault's first capture. Existing refresh
        // ownership stays put; pairing must never create a second refresher.
        for (const integration of remote) {
          const state = integration.oauthState;
          if (!state?.signedIn || state.server === undefined || state.tokenItemId === undefined)
            continue;
          yield* tokenStore.backfillAttachment(
            state.tokenItemId,
            signInAttachment(integration, {
              server: state.server,
              registration: state.registration,
              expiresAt: state.expiresAt ?? null,
              refreshAt: state.refreshAt,
              refreshOwner: state.refreshOwner ?? peers.self,
            }),
          );
        }
        const attached = yield* tokenStore.attached;
        const nowMs = yield* Clock.currentTimeMillis;
        let changed = false;
        for (const { id } of remote) {
          const adopted = yield* Effect.gen(function* () {
            const integration = yield* getById(id);
            const state = integration.oauthState;
            const pointed = attached.find((signIn) => signIn.item.id === state?.tokenItemId);
            // Legacy items remain usable until their attachment is backfilled.
            if (
              state?.signedIn &&
              state.tokenItemId !== undefined &&
              pointed === undefined &&
              Option.isSome(yield* tokenStore.revision(state.tokenItemId))
            )
              return false;
            const next =
              // Preserve a local legacy manual-client grant until its owner refreshes
              // with client identity metadata. A changed definition has cleared this
              // state already; a peer without a local grant cannot use this exception.
              pointed !== undefined &&
              adoptable(integration, pointed, nowMs, state?.signedIn === true)
                ? pointed
                : attached.find((signIn) => adoptable(integration, signIn, nowMs));
            if (next === undefined) {
              // Signed out elsewhere, or the item was deleted: only a new sign-in helps.
              if (state?.signedIn)
                yield* markNeedsSignIn(integration, "The sign-in was removed. Sign in again.");
              return false;
            }
            const nextState = {
              signedIn: true,
              server: next.attachment.server,
              ...(next.attachment.registration === undefined
                ? {}
                : { registration: next.attachment.registration }),
              tokenItemId: next.item.id,
              expiresAt: next.attachment.expiresAt,
              refreshAt:
                next.attachment.refreshAt ?? tokenRefreshAt(next.attachment.expiresAt, null),
              refreshOwner: next.attachment.refreshOwner,
            };
            if (state !== undefined && oauthStateKey(state) === oauthStateKey(nextState))
              return false;
            liveTokens.delete(id);
            yield* persistState(id, integration, () => nextState);
            yield* Ref.update(checks, (current) => {
              const updated = new Map(current);
              updated.delete(id);
              return updated;
            });
            return true;
          }).pipe(integrationLock(id).withPermits(1));
          changed = changed || adopted;
        }
        if (changed) yield* notify;
      }).pipe(
        adoptPermit.withPermits(1),
        Effect.mapError(failure("adopt synced sign-ins", "storage")),
        Effect.withSpan("Integrations.adoptSyncedSignIns"),
      );

    const refreshSharedSignIns: Integrations["Service"]["refreshSharedSignIns"] = Effect.gen(
      function* () {
        if (!(yield* peers.sharing)) return;
        const nowMs = yield* Clock.currentTimeMillis;
        const due = (yield* tokenStore.attached).filter(
          ({ attachment, hasAccessToken, hasRefreshToken }) =>
            attachment.refreshOwner === peers.self &&
            hasAccessToken &&
            hasRefreshToken &&
            attachment.expiresAt !== null &&
            (attachment.refreshAt ?? attachment.expiresAt - REFRESH_SKEW_MS) <= nowMs,
        );
        if (due.length === 0) return;
        const all = yield* rows();
        for (const signIn of due) {
          const id = IntegrationId.make(signIn.attachment.integrationId);
          const integration = all.find((entry) => entry.id === id);
          const signsIn =
            integration !== undefined &&
            integration.transport !== "local" &&
            usesOAuth(integration) &&
            integration.oauthState?.signedIn === true &&
            integration.oauthState.tokenItemId === signIn.item.id;
          // An integration here that uses another item, or none yet, is adoption's to settle.
          if (integration !== undefined && !signsIn) continue;
          yield* (signsIn ? accessToken(id).pipe(Effect.asVoid) : refreshDetached(signIn)).pipe(
            integrationLock(id).withPermits(1),
            Effect.catch((error) =>
              Effect.logWarning("Could not refresh a shared integration sign-in", {
                reason: error.reason,
              }),
            ),
          );
        }
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not check shared integration sign-ins", { reason: error.reason }),
      ),
      Effect.withSpan("Integrations.refreshSharedSignIns"),
    );

    yield* sql<{ payload_json: string }>`SELECT payload_json FROM integrations`.pipe(
      Effect.mapError(failure("migrate credentials", "storage")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => readStored(row.payload_json), { discard: true }),
      ),
      Effect.orDie,
    );

    // Sign-ins that arrive through vault sync, and removals, apply here as they land.
    yield* tokenStore.syncedChanges.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          for (const [id, live] of liveTokens)
            if (live.itemId === change.itemId) liveTokens.delete(id);
        }).pipe(
          Effect.andThen(adoptSyncedSignIns()),
          Effect.catch((error) =>
            Effect.logWarning("Could not apply a synced integration sign-in", {
              reason: error.reason,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* adoptSyncedSignIns().pipe(Effect.ignore);

    const persistDefinition = (integration: StoredIntegration, previous?: StoredIntegration) =>
      Effect.gen(function* () {
        yield* persist(integration);
        if (Option.isSome(sync)) yield* sync.value.publish(integration, previous);
      }).pipe(sql.withTransaction, Effect.mapError(failure("write", "storage")));

    if (Option.isSome(sync))
      yield* sync.value.changes.pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            liveTokens.clear();
            yield* adoptSyncedSignIns();
            yield* Ref.set(cache, new Map());
            yield* Ref.set(checks, new Map());
            yield* notify;
          }),
        ),
        Effect.forkScoped,
      );

    if (Option.isSome(local)) {
      yield* rows().pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all.filter((item) => item.transport === "local" && item.enabled),
            (item) => local.value.start(item).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
        Effect.ignore,
      );
      // A failed check outlives a process that crashed and came back: once it
      // runs again, probe it, so its status is not `error` until the next call.
      const probing = new Set<IntegrationId>();
      const reprobe = Effect.gen(function* () {
        const checked = yield* Ref.get(checks);
        for (const integration of yield* rows()) {
          const check = checked.get(integration.id);
          if (
            integration.transport !== "local" ||
            !integration.enabled ||
            check === undefined ||
            check.ok ||
            check.updatedAt !== integration.updatedAt ||
            probing.has(integration.id) ||
            (yield* local.value.status(integration.id))?.state !== "running"
          )
            continue;
          probing.add(integration.id);
          yield* fetchTools(integration).pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => probing.delete(integration.id))),
            Effect.forkScoped,
          );
        }
      }).pipe(Effect.ignore);
      // Process restarts and finished Google sign-ins reach Settings like any other change.
      yield* local.value.changes.pipe(
        Stream.runForEach(() => notify.pipe(Effect.andThen(reprobe))),
        Effect.forkScoped,
      );
    }

    /** The account a secret form updates, which must belong to that catalog entry. */
    const targetAccount = (
      id: IntegrationId | undefined,
      catalogId: string,
    ): Effect.Effect<StoredIntegration | undefined, IntegrationError> =>
      id === undefined
        ? Effect.succeed(undefined)
        : getById(id).pipe(
            Effect.flatMap((current) =>
              integrationCatalogEntryFor(current)?.id === catalogId
                ? Effect.succeed(current)
                : Effect.fail(
                    new IntegrationError({
                      operation: "save credentials",
                      reason: "invalid_request",
                    }),
                  ),
            ),
          );

    const service: Integrations["Service"] = Integrations.of({
      previewNative: () =>
        Option.isSome(nativeImport)
          ? nativeImport.value.preview
          : Effect.fail(
              new IntegrationError({
                operation: "preview native integrations",
                reason: "upstream_unreachable",
              }),
            ),
      importNative: () =>
        Effect.gen(function* () {
          const preview = yield* service.previewNative();
          const existing = (yield* service.list()).integrations.map((row) => row.integration);
          const imported: string[] = [];
          for (const definition of preview.definitions) {
            if (existing.some((item) => item.deletedAt === null && item.name === definition.name))
              continue;
            yield* service.create(definition);
            imported.push(definition.name);
          }
          return {
            imported,
            reconnect: preview.reconnect,
            warnings: preview.warnings,
            incomplete: preview.incomplete,
          };
        }),
      setupGuide: (service) => Effect.succeed(integrationSetupGuide(service)),
      list: (options) =>
        rows().pipe(
          Effect.flatMap((all) => summaries(all, options?.includeProcessOutput === true)),
        ),
      listForProject: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) =>
              integrationVisibleTo({ ...integration, enabled: true }, labelId),
            ),
          ),
          Effect.flatMap(summaries),
        ),
      create: (request, options) =>
        Effect.gen(function* () {
          let input =
            "preset" in request
              ? Option.isSome(local)
                ? yield* local.value.prepare(request, {
                    fromAgent: options?.fromAgent,
                    origin: options?.ownerOrigin,
                  })
                : yield* new IntegrationError({
                    operation: "connect Google",
                    reason: "upstream_unreachable",
                  })
              : request;
          if (
            input.transport === "local" &&
            (input.local?.preset !== "google-workspace" ||
              input.local.version !== GOOGLE_WORKSPACE_VERSION ||
              input.url !== "https://accounts.google.com" ||
              Object.keys(input.headers).length > 0 ||
              input.auth !== undefined ||
              !input.accountLabel?.trim())
          ) {
            return yield* new IntegrationError({ operation: "create", reason: "invalid_request" });
          }
          // Definitions from MCP and approved proposals cannot supply a callback destination.
          if (input.transport === "local" && input.local && Option.isSome(local)) {
            const prepared = yield* local.value.prepare(
              {
                preset: input.local.preset,
                accountLabel: input.accountLabel?.trim() ?? "",
                callbackOrigin: input.local.callbackOrigin,
              },
              { fromAgent: options?.fromAgent, origin: options?.ownerOrigin },
            );
            input = { ...input, local: prepared.local };
          }
          if (options?.fromAgent && input.transport === "stdio" && !options.approveExecutable)
            return yield* new IntegrationError({
              operation: "approve executable integration",
              reason: "approval_required",
            });
          if (input.auth?.server !== undefined && options?.fromAgent && !options.approveCredentials)
            return yield* new IntegrationError({
              operation: "approve OAuth server",
              reason: "approval_required",
            });
          yield* validateCommand(input);
          yield* validateUrl(input.url);
          yield* validateAuth(input.auth, "create");
          yield* validateTransport(input);
          for (const template of Object.values(input.headers)) {
            for (const ref of credentialRefsIn(template)) {
              if (Credentials.parseCredentialRef(ref) === undefined) {
                return yield* new IntegrationError({
                  operation: "create",
                  reason: "credential_unresolved",
                });
              }
            }
          }
          const existing = yield* rows();
          if (existing.some((integration) => integration.name === input.name)) {
            return yield* new IntegrationError({ operation: "create", reason: "conflict" });
          }
          const accounts = existing.filter(
            (entry) =>
              entry.transport === input.transport &&
              entry.url.replace(/\/+$/, "") === input.url.replace(/\/+$/, ""),
          );
          let accountLabel = input.accountLabel?.trim();
          if (!accountLabel && accounts.length > 0) {
            let ordinal = Math.max(2, accounts.length + 1);
            while (accounts.some((entry) => entry.accountLabel === `#${ordinal}`)) ordinal++;
            accountLabel = `#${ordinal}`;
          }
          const at = yield* now;
          let integration: StoredIntegration = {
            id: IntegrationId.make(
              `integration:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure("create", "storage")))}`,
            ),
            name: input.name,
            displayName: input.displayName,
            ...(input.icon === undefined ? {} : { icon: input.icon }),
            ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
            transport: input.transport,
            ...(input.local ? { local: input.local } : {}),
            ...(input.command ? { command: input.command } : {}),
            url: input.url,
            ...(input.endpointRef === undefined ? {} : { endpointRef: input.endpointRef }),
            headers: input.headers,
            credentialOrigin: new URL(input.url).origin,
            approvedCredentialItems: options?.approveCredentials
              ? credentialItemsIn(input.headers, input.auth, input.command, input.endpointRef)
              : [],
            enabled: input.enabled ?? true,
            scope: input.scope,
            hint: input.hint,
            ...(accountLabel ? { accountLabel } : {}),
            ...(options?.addedByAgent === undefined
              ? {}
              : { provenance: { addedByAgent: options.addedByAgent } }),
            ...(input.auth === undefined ? {} : { auth: input.auth }),
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          };
          integration = yield* protectLiterals(yield* protectEndpoint(integration));
          yield* persistDefinition(integration);
          // The process starts now so a sign-in link answers quickly; listing retries a failure.
          if (integration.transport === "local" && Option.isSome(local))
            yield* local.value.start(integration).pipe(Effect.ignore);
          yield* notify;
          // A sign-in for this id may already have arrived through the vault.
          yield* adoptSyncedSignIns(integration.id).pipe(Effect.ignore);
          return { integration: redactIntegration(integration) };
        }).pipe(Effect.mapError(failure("create", "storage"))),
      update: (masked, options) =>
        Effect.gen(function* () {
          const current = yield* getById(masked.id);
          if (
            (current.transport === "local" && integrationDestinationChanged(current, masked)) ||
            (current.transport !== "local" && masked.transport === "local")
          )
            return yield* new IntegrationError({
              operation: "update local integration",
              reason: "invalid_request",
            });
          if (
            options?.fromAgent &&
            integrationExecutableChanged(current, masked) &&
            !options.approveExecutable
          )
            return yield* new IntegrationError({
              operation: "approve executable integration",
              reason: "approval_required",
            });
          if (!integrationVisibleTo({ ...current, enabled: true }, options?.callerLabelId))
            return yield* new IntegrationError({ operation: "update", reason: "not_found" });
          if (options?.preserveScope && integrationScopeWidened(current, masked))
            return yield* new IntegrationError({
              operation: "update",
              reason: "approval_required",
            });
          // Nothing to change (an agent asking for a fresh sign-in link): keep the
          // version, so a managed process and its pending sign-in keep running.
          if (Object.entries(masked).every(([key, value]) => key === "id" || value === undefined))
            return { integration: redactIntegration(current), changed: false };
          // A masked value is one the caller left as it was.
          if (masked.command !== undefined) {
            const env = Object.fromEntries(
              yield* Effect.forEach(Object.entries(masked.command.env), ([key, value]) => {
                if (value !== HEADER_MASK) return Effect.succeed([key, value] as const);
                const stored = current.command?.env[key];
                return stored === undefined
                  ? Effect.fail(
                      new IntegrationError({ operation: "update", reason: "invalid_request" }),
                    )
                  : Effect.succeed([key, stored] as const);
              }),
            );
            masked = { ...masked, command: { ...masked.command, env } };
          }
          const input: IntegrationUpdateInput =
            masked.headers === undefined
              ? masked
              : {
                  ...masked,
                  headers: yield* Effect.forEach(Object.entries(masked.headers), ([name, value]) =>
                    value !== HEADER_MASK
                      ? Effect.succeed([name, value] as const)
                      : current.headers[name] !== undefined
                        ? Effect.succeed([name, current.headers[name]] as const)
                        : Effect.fail(
                            new IntegrationError({
                              operation: "update",
                              reason: "invalid_request",
                            }),
                          ),
                  ).pipe(Effect.map(Object.fromEntries<string>)),
                };
          if (
            (options?.holdStoredSecrets || options?.fromAgent) &&
            integrationAccountLabelChanged(current, input)
          )
            return yield* new IntegrationError({
              operation: "change account label",
              reason: "approval_required",
            });
          if (
            (options?.fromAgent || options?.holdStoredSecrets) &&
            !options.approveCredentials &&
            input.auth !== undefined &&
            (["issuer", "authorizationEndpoint", "tokenEndpoint"] as const).some(
              (key) => input.auth?.server?.[key] !== current.auth?.server?.[key],
            )
          )
            return yield* new IntegrationError({
              operation: "approve OAuth server",
              reason: "approval_required",
            });
          const auth = input.auth === undefined ? current.auth : (input.auth ?? undefined);
          if (
            (options?.holdStoredSecrets || options?.fromAgent) &&
            integrationDestinationChanged(current, input) &&
            (current.endpointRef !== undefined ||
              current.oauthState?.tokenItemId !== undefined ||
              headersKeepStoredSecrets(current, input.headers ?? current.headers) ||
              Object.values(current.command?.env ?? {}).some(
                (value) => credentialRefsIn(value).length > 0,
              ) ||
              credentialRefsIn(auth?.clientSecret ?? "").length > 0)
          ) {
            return yield* new IntegrationError({
              operation: "update",
              reason: "approval_required",
            });
          }
          if (
            options?.preserveCredentialDestination &&
            integrationDestinationChanged(current, input)
          ) {
            return yield* new IntegrationError({ operation: "update", reason: "invalid_request" });
          }
          yield* validateCommand({
            transport: input.transport ?? current.transport,
            command: input.command ?? current.command,
            auth,
            headers: input.headers ?? current.headers,
          });
          if (input.url !== undefined) yield* validateUrl(input.url);
          yield* validateAuth(auth, "update");
          const endpointRef =
            input.endpointRef === undefined
              ? current.endpointRef
              : (input.endpointRef ?? undefined);
          yield* validateTransport({
            transport: input.transport ?? current.transport,
            ...(endpointRef === undefined ? {} : { endpointRef }),
            url: input.url ?? current.url,
            headers: input.headers ?? current.headers,
            ...(auth === undefined ? {} : { auth }),
          });
          const credentialOrigin = options?.preserveCredentialDestination
            ? (current.credentialOrigin ?? new URL(current.url).origin)
            : new URL(input.url ?? current.url).origin;
          const headers = input.headers ?? current.headers;
          const approvedCredentialItems = options?.approveCredentials
            ? credentialItemsIn(headers, auth, input.command ?? current.command, endpointRef)
            : credentialOrigin === current.credentialOrigin
              ? (current.approvedCredentialItems ?? [])
              : [];
          // Tokens belong to one server and client: a new URL or client id needs a new sign-in.
          const keepSignIn =
            auth?.type === "oauth" &&
            (input.url === undefined || input.url === current.url) &&
            auth.clientId === current.auth?.clientId &&
            auth.server?.issuer === current.auth?.server?.issuer &&
            auth.server?.authorizationEndpoint === current.auth?.server?.authorizationEndpoint &&
            auth.server?.tokenEndpoint === current.auth?.server?.tokenEndpoint;
          const {
            auth: _auth,
            endpointRef: _endpointRef,
            accountLabel: _label,
            oauthState,
            ...rest
          } = current;
          const accountLabel =
            input.accountLabel === undefined ? current.accountLabel : input.accountLabel.trim();
          let integration: StoredIntegration = {
            ...rest,
            ...(endpointRef === undefined ? {} : { endpointRef }),
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.icon === undefined ? {} : { icon: input.icon }),
            ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.hint === undefined ? {} : { hint: input.hint }),
            ...(accountLabel ? { accountLabel } : {}),
            ...(auth === undefined ? {} : { auth }),
            ...(keepSignIn && oauthState !== undefined ? { oauthState } : {}),
            ...(current.provenance?.signedInAt === undefined &&
            current.oauthState?.tokenItemId !== undefined
              ? {
                  provenance: {
                    ...current.provenance,
                    signedInAt: current.updatedAt,
                    signedInViaAgent: false,
                  },
                }
              : {}),
            updatedAt: yield* now,
            credentialOrigin,
            approvedCredentialItems,
          };
          integration = yield* protectLiterals(yield* protectEndpoint(integration));
          yield* persistDefinition(integration, current);
          if (!keepSignIn) yield* dropTokens(current);
          yield* invalidate(integration.id);
          return { integration: redactIntegration(integration), changed: true };
        }).pipe(
          sql.withTransaction,
          integrationLock(masked.id).withPermits(1),
          // Once committed, the old process gives way; the next list starts the new version.
          Effect.tap(({ integration, changed }) =>
            changed &&
            (integration.transport === "local" || integration.transport === "stdio") &&
            Option.isSome(local)
              ? local.value.stop(integration.id, integration)
              : Effect.void,
          ),
          Effect.tap(({ changed }) => (changed ? notify : Effect.void)),
          Effect.map(({ integration }) => ({ integration })),
          Effect.mapError(failure("update", "storage")),
        ),
      remove: (id, options) =>
        Effect.gen(function* () {
          const current = yield* getById(id).pipe(
            Effect.catchTags({
              IntegrationError: (error) =>
                error.reason === "not_found" ? Effect.succeed(undefined) : Effect.fail(error),
            }),
          );
          if (current === undefined) return { deleted: false };
          if (!integrationVisibleTo({ ...current, enabled: true }, options?.callerLabelId))
            return yield* new IntegrationError({ operation: "delete", reason: "not_found" });
          if (
            (current.transport === "local" || current.transport === "stdio") &&
            Option.isSome(local)
          )
            yield* local.value.stop(id);
          const at = yield* now;
          const { oauthState: _, ...rest } = current;
          yield* persistDefinition({ ...rest, deletedAt: at, updatedAt: at }, current);
          yield* dropTokens(current);
          yield* invalidate(id);
          yield* notify;
          return { deleted: true };
        }).pipe(integrationLock(id).withPermits(1), Effect.mapError(failure("delete", "storage"))),
      testConnection: (id, labelId) =>
        Effect.gen(function* () {
          const integration = yield* getById(id);
          if (!integration.enabled) {
            return yield* new IntegrationError({
              operation: "test connection",
              reason: "disabled",
            });
          }
          if (!integrationVisibleTo(integration, labelId))
            return yield* new IntegrationError({
              operation: "test connection",
              reason: "not_found",
            });
          const checkedAt = yield* now;
          const result = yield* fetchTools(integration, labelId).pipe(
            // A passing test is a fresh tool list, so the list view shows it.
            Effect.tap((tools) =>
              Effect.gen(function* () {
                const key = `${integration.id}:${integration.updatedAt}${labelId === undefined ? "" : labelId === null ? ":unfiled" : `:project:${labelId}`}`;
                const at = yield* Clock.currentTimeMillis;
                yield* Ref.update(cache, (entries) =>
                  new Map(entries).set(key, { key, atMs: at, result: tools }),
                );
                yield* notify;
              }),
            ),
            Effect.map((tools): IntegrationTestResult => ({
              status: "connected",
              toolCount: tools.tools.length,
              message: `Connected; ${tools.tools.length} tool(s) available.`,
            })),
            Effect.catch((error: IntegrationError) =>
              Effect.succeed<IntegrationTestResult>({
                status:
                  error.reason === "sign_in_required" && refreshWaitMessage(error) === undefined
                    ? "needs_sign_in"
                    : "disconnected",
                toolCount: 0,
                reason: error.reason,
                message:
                  (error.reason === "upstream_error" && typeof error.cause === "string") ||
                  refreshWaitMessage(error) !== undefined
                    ? checkMessage(error)
                    : `Could not connect (${error.reason}).`,
              }),
            ),
          );
          return { ...result, checkedAt };
        }).pipe(Effect.mapError(failure("test connection", "storage"))),
      listTools: (name, labelId) => listTools(name, labelId),
      callTool: (name, tool, args, labelId) =>
        Effect.gen(function* () {
          const integration = yield* getByName(name, labelId);
          const result = yield* rpc(
            integration,
            "tools/call",
            {
              name: tool,
              arguments: args ?? {},
            },
            labelId,
          );
          // A server that echoes its bearer token must not hand it to the agent.
          const live = liveTokens.get(integration.id);
          const sanitized = redactValue(
            result ?? null,
            [live?.accessToken, live?.refreshToken, live?.clientSecret].filter(
              (secret): secret is string => secret !== undefined && secret.length >= 8,
            ),
          );
          const record =
            typeof sanitized === "object" && sanitized !== null
              ? (sanitized as Record<string, unknown>)
              : undefined;
          return {
            content: record !== undefined && "content" in record ? record.content : sanitized,
            ...(record !== undefined && "structuredContent" in record
              ? { structuredContent: record.structuredContent }
              : {}),
            ...(typeof record?.isError === "boolean" ? { isError: record.isError } : {}),
          } satisfies IntegrationCallResult;
        }),
      contextIntegrations: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) =>
              integrationVisibleTo({ ...integration, enabled: true }, labelId),
            ),
          ),
          Effect.flatMap(summaries),
          Effect.map(({ integrations }) =>
            integrations.map((summary) => ({
              ...summary.integration,
              status: summary.integration.enabled ? summary.status : ("disabled" as const),
            })),
          ),
        ),
      subscribe: () =>
        // Subscribed alongside the first list, so a change in between is not missed.
        Stream.mergeAll([Stream.make(undefined), Stream.fromPubSub(changes)], {
          concurrency: "unbounded",
        }).pipe(Stream.mapEffect(() => rows().pipe(Effect.flatMap(summaries)))),
      beginSignIn: (id, from) =>
        Effect.gen(function* () {
          const integration = yield* getById(id);
          if (!integration.enabled)
            return yield* new IntegrationError({ operation: "sign in", reason: "disabled" });
          // A managed account signs in through its own process, on its fixed callback origin.
          if (integration.transport === "local") {
            if (Option.isNone(local))
              return yield* new IntegrationError({
                operation: "sign in",
                reason: "upstream_unreachable",
              });
            yield* local.value.start(integration);
            const link = yield* local.value.signInLink(integration, true, from);
            if (link === undefined)
              return yield* new IntegrationError({
                operation: "sign in (already signed in)",
                reason: "invalid_request",
              });
            return link;
          }
          if (!usesOAuth(integration))
            return yield* new IntegrationError({ operation: "sign in", reason: "invalid_request" });
          yield* validateTransport(integration);
          const origin = yield* selectCallbackOrigin(from, integration.browserOrigin);
          const redirectUri = `${origin}${OAuth.CALLBACK_PATH}`;
          const server = yield* protocol.discover(integration.url);
          yield* authorizeOAuthServer(integration, server);
          if (integration.oauthState?.server === undefined) {
            yield* persistState(integration.id, integration, (state) => ({
              ...state,
              signedIn: state?.signedIn ?? false,
              server,
            }));
          }
          const auth = integration.auth!;
          const previous = integration.oauthState;
          // A registration made earlier for this server and redirect is reused.
          const reusable =
            auth.clientId === undefined &&
            previous?.registration !== undefined &&
            previous.server?.issuer === server.issuer &&
            previous.registration.redirectUris.includes(redirectUri)
              ? previous.registration
              : undefined;
          const registered =
            auth.clientId !== undefined || reusable !== undefined
              ? undefined
              : yield* protocol.register(server, redirectUri);
          const registration = reusable ?? registered?.registration;
          const clientId = auth.clientId ?? registration!.clientId;
          const { verifier, challenge } = yield* OAuth.pkcePair.pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
          const state = yield* OAuth.randomState.pipe(Effect.provideService(Crypto.Crypto, crypto));
          const nowMs = yield* Clock.currentTimeMillis;
          yield* Ref.update(pendingSignIns, (current) => {
            const next = new Map([...current].filter(([, pending]) => pending.expiresAtMs > nowMs));
            // Owner and agent requests have separate bounded slots.
            const peers = [...next].filter(
              ([, pending]) => pending.fromAgent === (from.fromAgent === true),
            );
            while (peers.length >= MAX_PENDING_SIGN_INS) next.delete(peers.shift()![0]);
            return next.set(state, {
              integrationId: integration.id,
              fromAgent: from.fromAgent === true,
              url: integration.url,
              definition: definitionKey(integration),
              server,
              redirectUri,
              verifier,
              registration,
              newClientSecret: registered?.clientSecret,
              expiresAtMs: nowMs + SIGN_IN_TTL_MS,
            });
          });
          const scope = auth.scope?.trim() || server.scopesSupported?.join(" ") || undefined;
          return {
            authorizationUrl: OAuth.authorizationUrl({
              server,
              clientId,
              redirectUri,
              state,
              challenge,
              scope,
            }),
            redirectUri,
          };
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const integration = yield* getById(id).pipe(Effect.option);
              if (Option.isSome(integration)) yield* recordCheck(integration.value, error);
            }),
          ),
          Effect.mapError(failure("sign in", "upstream_error")),
        ),
      completeSignIn: (callback) =>
        Effect.gen(function* () {
          const rejected = new IntegrationError({
            operation: "complete sign in",
            reason: "invalid_request",
          });
          if (callback.state === undefined) return yield* rejected;
          const state = callback.state;
          // Single use: the state is gone whether or not what follows succeeds.
          const pending = yield* Ref.modify(pendingSignIns, (current) => {
            const found = current.get(state);
            if (found === undefined) return [undefined, current] as const;
            const next = new Map(current);
            next.delete(state);
            return [found, next] as const;
          });
          const nowMs = yield* Clock.currentTimeMillis;
          if (pending === undefined || pending.expiresAtMs <= nowMs) return yield* rejected;
          // RFC 9207: a response naming another issuer is a mix-up attempt.
          if (
            (pending.server.authorizationResponseIssParameterSupported === true &&
              callback.iss === undefined) ||
            (callback.iss !== undefined && callback.iss !== pending.server.issuer)
          )
            return yield* rejected;
          const integration = yield* getById(pending.integrationId);
          if (
            !integration.enabled ||
            !usesOAuth(integration) ||
            integration.transport === "local" ||
            definitionKey(integration) !== pending.definition
          )
            return yield* rejected;
          if (callback.error !== undefined || callback.code === undefined) {
            yield* recordCheck(
              integration,
              new IntegrationError({
                operation: "sign in",
                reason: "upstream_error",
                cause: `Sign-in did not finish (${(callback.error ?? "no code").slice(0, 64)}).`,
              }),
            );
            return yield* rejected;
          }
          const previous = integration.oauthState;
          // A reused registration's secret is the one stored with the earlier sign-in.
          const clientSecret =
            pending.newClientSecret ??
            (pending.registration !== undefined &&
            previous?.tokenItemId !== undefined &&
            pending.registration.clientId === previous.registration?.clientId
              ? yield* tokenStore.clientSecret(previous.tokenItemId)
              : undefined);
          const oauth = yield* oauthClient(
            integration,
            pending.server,
            pending.registration,
            clientSecret,
          );
          const tokens = yield* protocol
            .exchangeCode({
              server: pending.server,
              client: oauth,
              code: callback.code,
              verifier: pending.verifier,
              redirectUri: pending.redirectUri,
              nowMs,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new IntegrationError({
                    operation: "complete sign in",
                    reason: "upstream_error",
                    cause: error.message,
                  }),
              ),
            );
          // A new sign-in anywhere replaces the shared item and picks its refresher afresh.
          const refreshOwner = yield* peers.defaultRefreshOwner;
          // The exchange does not block edits. Only a current definition may commit
          // its result; stale tokens never enter the vault or an upstream request.
          yield* integrationLock(integration.id).withPermits(1)(
            Effect.gen(function* () {
              const current = yield* getById(integration.id);
              if (!current.enabled || definitionKey(current) !== pending.definition)
                return yield* rejected;
              // Adopted from another machine meanwhile: replace that item, not a second one.
              const { itemId, revision } = yield* tokenStore.write({
                itemId: current.oauthState?.tokenItemId ?? previous?.tokenItemId,
                name: tokenItemName(integration),
                label: `${integrationTitle(integration)} sign-in`,
                host: new URL(integration.url).hostname,
                tokens: { ...tokens, clientSecret },
                attachment: signInAttachment(integration, {
                  server: pending.server,
                  registration: pending.registration,
                  expiresAt: tokens.expiresAt,
                  refreshAt: tokenRefreshAt(tokens.expiresAt, nowMs),
                  refreshOwner,
                }),
              });
              liveTokens.set(integration.id, {
                ...tokens,
                clientSecret,
                itemId,
                revision,
                expiresAt: tokens.expiresAt,
                refreshOwner,
                server: pending.server,
                registration: pending.registration,
                refreshAt: tokenRefreshAt(tokens.expiresAt, nowMs),
              });
              yield* persistState(
                integration.id,
                integration,
                () => ({
                  signedIn: true,
                  server: pending.server,
                  ...(pending.registration === undefined
                    ? {}
                    : { registration: pending.registration }),
                  tokenItemId: itemId,
                  expiresAt: tokens.expiresAt,
                  refreshAt: tokenRefreshAt(tokens.expiresAt, nowMs),
                  refreshOwner,
                }),
                new URL(pending.redirectUri).origin,
                { signedInAt: yield* now, signedInViaAgent: pending.fromAgent },
              ).pipe(
                Effect.tapError(() =>
                  dropTokens({
                    ...integration,
                    oauthState: { signedIn: false, tokenItemId: itemId },
                  }),
                ),
              );
            }).pipe(Effect.uninterruptible),
          );

          yield* Ref.update(checks, (current) => {
            const next = new Map(current);
            next.delete(integration.id);
            return next;
          });
          // A first tool listing makes the row read "Connected" with its tool count.
          const signedIn = yield* getById(integration.id);
          if (signedIn.enabled)
            yield* fetchTools(signedIn).pipe(
              Effect.tap((tools) =>
                Effect.gen(function* () {
                  const key = `${signedIn.id}:${signedIn.updatedAt}`;
                  const at = yield* Clock.currentTimeMillis;
                  yield* Ref.update(cache, (entries) =>
                    new Map(entries).set(key, { key, atMs: at, result: tools }),
                  );
                }),
              ),
              Effect.ignore,
            );
          yield* notify;
          return { integration: redactIntegration(signedIn) };
        }).pipe(
          Effect.tapError((error) =>
            error.reason === "invalid_request"
              ? Effect.void
              : Effect.logWarning("Integration sign-in did not finish", { reason: error.reason }),
          ),
          Effect.mapError(failure("complete sign in", "storage")),
        ),
      connectFromCatalog: (request, options) =>
        Effect.gen(function* () {
          const entry = integrationCatalogEntry(request.catalogId);
          const resolution = resolveCatalogConnect(request, {
            existingNames: new Set((yield* rows()).map((integration) => integration.name)),
            requestOrigin: options.origin.origin,
            fromAgent: options.origin.fromAgent,
          });
          if (resolution._tag === "needs") {
            // A missing key or app is a guided step, not a failure.
            const setup =
              entry === undefined || resolution.mode === undefined
                ? undefined
                : catalogSetupFor({
                    entry,
                    mode: resolution.mode,
                    redirectUri: remoteRedirectUri(options.origin.origin),
                  });
            if (setup !== undefined) return { setup } satisfies IntegrationConnectResult;
            return yield* new IntegrationError({
              operation: "connect from catalog",
              reason: "invalid_request",
              cause: resolution.message,
            });
          }
          const created = yield* service
            .create(resolution.input, {
              ...options,
              fromAgent: options.origin.fromAgent,
              ownerOrigin: options.origin.fromAgent ? undefined : options.origin.origin,
            })
            .pipe(Effect.result);
          if (created._tag === "Failure") {
            const error = created.failure;
            // No usable Google client yet: nothing is created, and the row shows how to make one.
            if (
              entry?.kind === "local-preset" &&
              (error.reason === "google_client_missing" ||
                error.reason === "credential_not_allowed" ||
                error.reason === "credential_unresolved")
            ) {
              const setup = setupActionFor({
                entry,
                reason: error.reason,
                redirectUri: Option.isSome(local)
                  ? yield* local.value.redirectUri(undefined, {
                      ...options.origin,
                      origin: request.inputs?.callbackOrigin ?? options.origin.origin,
                    })
                  : undefined,
              });
              if (setup !== undefined) return { setup } satisfies IntegrationConnectResult;
            }
            return yield* Effect.fail(error);
          }
          const { integration } = created.success;
          if (!resolution.signsIn) return { integration } satisfies IntegrationConnectResult;
          return yield* service.prepareSignIn(integration.id, {
            ...options.origin,
            callbackOrigin: request.inputs?.callbackOrigin,
          });
        }),
      adoptSyncedSignIns,
      refreshSharedSignIns,
      prepareSignIn: (id, from) =>
        Effect.gen(function* () {
          const stored = yield* getById(id);
          const integration = redactIntegration(stored);
          if (!usesOAuth(stored) && stored.transport !== "local")
            return { integration } satisfies IntegrationConnectResult;
          const summary = (yield* summaries([stored])).integrations[0];
          if (summary === undefined) return { integration };
          const keep = summary.setup === undefined ? {} : { setup: summary.setup };
          if (summary.status === "error") return { integration, ...keep };
          if (summary.status !== "needs_sign_in") return { integration };
          // Only the owner reauthorizes an account that signed in before.
          const signIn = yield* service.beginSignIn(id, from).pipe(Effect.result);
          if (signIn._tag === "Success") return { integration, signIn: signIn.success };
          const error = signIn.failure;
          if (error.reason === "approval_required") return { integration, ...keep };
          const setup = setupActionFor({
            entry: integrationCatalogEntryFor(stored),
            integration: stored,
            status: "needs_sign_in",
            reason: error.reason,
            // A refused callback origin explains itself; anything else gets the plain status text.
            message:
              error.reason === "invalid_request" && typeof error.cause === "string"
                ? error.cause
                : checkMessage(error),
            redirectUri:
              stored.transport === "local"
                ? yield* redirectUriFor(stored)
                : (remoteRedirectUri(from.origin) ?? (yield* redirectUriFor(stored))),
            runtime:
              error.reason === "local_runtime_missing" ? yield* runtimePlan("uv") : undefined,
            syncedFrom: stored.syncedFrom,
          });
          return setup === undefined ? { integration } : { integration, setup };
        }),
      saveOAuthClient: (input, options) =>
        Effect.gen(function* () {
          if (input.catalogId === undefined) {
            const current = yield* getById(input.integrationId);
            if (
              current.transport !== "http" ||
              !usesOAuth(current) ||
              integrationCatalogEntryFor(current) !== undefined
            )
              return yield* new IntegrationError({
                operation: "save OAuth client",
                reason: "invalid_request",
              });
            const item = `${current.name}-client-secret`;
            yield* saveSecret({
              item,
              type: "api_key",
              fields: { value: input.clientSecret },
              domains: [new URL(current.url).hostname],
              label: `${current.displayName} client secret (${current.name})`,
            });
            yield* service.update(
              {
                id: current.id,
                auth: {
                  ...current.auth!,
                  type: "oauth",
                  clientId: input.clientId,
                  clientSecret: `{{credential:${item}.value}}`,
                },
              },
              { approveCredentials: true },
            );
            return yield* service.prepareSignIn(current.id, options.origin);
          }
          const entry = integrationCatalogEntry(input.catalogId);
          if (
            entry === undefined ||
            (entry.kind === "remote" && !entry.auth.some((auth) => auth.kind === "oauth_app"))
          )
            return yield* new IntegrationError({
              operation: "save OAuth client",
              reason: "invalid_request",
            });
          const current = yield* targetAccount(input.integrationId, entry.id);
          if (entry.kind === "local-preset") {
            // One client serves every Google account, under the preset's fixed item name.
            yield* saveSecret({
              item: GOOGLE_CLIENT_ITEM,
              type: "login",
              fields: { username: input.clientId, password: input.clientSecret },
              domains: ["accounts.google.com"],
              label: "Google OAuth client",
            });
            if (current !== undefined) {
              // A running process holds the old client; the next start reads the new one.
              if (Option.isSome(local)) yield* local.value.stop(current.id, current);
              yield* notify;
              return yield* service.prepareSignIn(current.id, options.origin);
            }
            // Accounts waiting for a client start with it on the next list.
            yield* notify;
            if (input.accountLabel === undefined) return {} satisfies IntegrationConnectResult;
            return yield* service.connectFromCatalog(
              {
                catalogId: entry.id,
                accountLabel: input.accountLabel,
                ...(input.scope === undefined ? {} : { scope: input.scope }),
              },
              { approveCredentials: true, origin: options.origin },
            );
          }
          const name =
            current?.name ??
            catalogIntegrationName(
              entry,
              input.accountLabel,
              new Set((yield* rows()).map((integration) => integration.name)),
            );
          const item = `${name}-client-secret`;
          yield* saveSecret({
            item,
            type: "api_key",
            fields: { value: input.clientSecret },
            domains: [entry.tokenHost ?? new URL(entry.url).hostname],
            label: `${entry.name} client secret (${name})`,
          });
          const clientSecret = `{{credential:${item}.value}}`;
          if (current !== undefined) {
            yield* service.update(
              {
                id: current.id,
                auth: {
                  type: "oauth",
                  clientId: input.clientId,
                  clientSecret,
                  ...(entry.oauthScope === undefined ? {} : { scope: entry.oauthScope }),
                },
              },
              { approveCredentials: true },
            );
            return yield* service.prepareSignIn(current.id, options.origin);
          }
          return yield* service.connectFromCatalog(
            {
              catalogId: entry.id,
              ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
              inputs: { auth: "oauth_app", clientId: input.clientId, clientSecret },
              ...(input.scope === undefined ? {} : { scope: input.scope }),
            },
            { approveCredentials: true, origin: options.origin },
          );
        }),
      saveApiKey: (input, options) =>
        Effect.gen(function* () {
          const entry = integrationCatalogEntry(input.catalogId);
          if (entry?.kind !== "remote" || !entry.auth.some((auth) => auth.kind === "api_key"))
            return yield* new IntegrationError({
              operation: "save API key",
              reason: "invalid_request",
            });
          const current = yield* targetAccount(input.integrationId, entry.id);
          const name =
            current?.name ??
            catalogIntegrationName(
              entry,
              input.accountLabel,
              new Set((yield* rows()).map((integration) => integration.name)),
            );
          const item = `${name}-api-key`;
          yield* saveSecret({
            item,
            type: "api_key",
            fields: { value: input.apiKey },
            domains: [new URL(entry.url).hostname],
            label: `${entry.name} key (${name})`,
          });
          const reference = `{{credential:${item}.value}}`;
          if (current !== undefined) {
            const { integration } = yield* service.update(
              {
                id: current.id,
                headers: { Authorization: `Bearer ${reference}` },
                // A key replaces a sign-in; its tokens are dropped.
                ...(current.auth === undefined ? {} : { auth: null }),
              },
              { approveCredentials: true },
            );
            return { integration } satisfies IntegrationConnectResult;
          }
          return yield* service.connectFromCatalog(
            {
              catalogId: entry.id,
              ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
              inputs: { auth: "api_key", apiKey: reference },
              ...(input.scope === undefined ? {} : { scope: input.scope }),
            },
            { approveCredentials: true, origin: options.origin },
          );
        }),
      installRuntime: (runtime) =>
        Effect.gen(function* () {
          if (Option.isNone(installer))
            return {
              installed: false,
              message: "Cogenly can't install programs on this machine.",
            } satisfies IntegrationInstallRuntimeResult;
          const result = yield* installer.value.install(runtime);
          // Listing starts the accounts that were waiting for it.
          if (result.installed) yield* notify;
          return result;
        }),
      subscribeSources: () =>
        service.subscribe().pipe(
          Stream.map(({ integrations }): IntegrationSourcesResult => ({
            sources: integrations
              .filter((summary) => summary.integration.enabled)
              .map(integrationSource),
          })),
          // Status flips without a source change (a tool count, a check time) push nothing.
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        ),
    });
    return service;
  });

type Requirements =
  | SqlClient.SqlClient
  | Crypto.Crypto
  | HttpClient.HttpClient
  | Credentials.IntegrationCredentials
  | Tokens.IntegrationTokens
  | IntegrationSyncPeers;

export const layerWith = (
  options: IntegrationsOptions,
): Layer.Layer<Integrations, never, Requirements> => Layer.effect(Integrations, make(options));

export const layer: Layer.Layer<Integrations, never, Requirements> = layerWith({});
