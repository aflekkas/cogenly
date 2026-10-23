import {
  Integration,
  IntegrationError,
  IntegrationId,
  type IntegrationCallResult,
  type IntegrationAddInput,
  type IntegrationCatalogConnectInput,
  type IntegrationMutationResult,
  type IntegrationListResult,
  type IntegrationName,
  type IntegrationSignIn,
  type IntegrationSummary,
  type IntegrationTestResult,
  type IntegrationToolsResult,
  type IntegrationUpdateInput,
  type ProjectLabelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { selectCallbackOrigin, type SignInOrigin } from "./SignInOrigin.ts";
import { redactValue } from "../vault/VaultRedactor.ts";
import { resolveCatalogConnect } from "./IntegrationCatalog.ts";
import * as Credentials from "./IntegrationCredentials.ts";
import * as OAuth from "./IntegrationOAuth.ts";
import * as Tokens from "./IntegrationTokens.ts";
import * as Local from "./local/LocalIntegrations.ts";
import { GOOGLE_WORKSPACE_VERSION } from "./local/GoogleWorkspace.ts";
import { IntegrationEndpointPolicy, withPublicEndpoint } from "./RemoteEndpoint.ts";

/**
 * Server-only OAuth state, persisted with the integration and stripped before
 * it reaches any client or agent. Secrets are in the vault item it names.
 */
const OAuthState = Schema.Struct({
  signedIn: Schema.Boolean,
  server: Schema.optional(OAuth.OAuthServer),
  /** The dynamically registered client; absent when the owner supplied a client id. */
  registration: Schema.optional(OAuth.OAuthClientRegistration),
  tokenItemId: Schema.optional(Schema.String),
  /** Access token expiry in epoch milliseconds; null when the server gave none. */
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
});
type OAuthState = typeof OAuthState.Type;

const StoredIntegration = Schema.Struct({
  ...Integration.fields,
  oauthState: Schema.optional(OAuthState),
  browserOrigin: Schema.optional(Schema.String),
});
type StoredIntegration = typeof StoredIntegration.Type;

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
): Array<string> => [
  ...new Set(
    [...Object.values(headers), auth?.clientSecret ?? ""].flatMap((template) =>
      credentialRefsIn(template).flatMap((ref) => {
        const parsed = Credentials.parseCredentialRef(ref);
        return parsed === undefined ? [] : [parsed.item];
      }),
    ),
  ),
];

const definitionKey = Schema.encodeSync(Schema.fromJsonString(Integration));

const usesOAuth = (integration: Integration) => integration.auth?.type === "oauth";

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
      value === "" || credentialRefsIn(value).length > 0 ? value : HEADER_MASK,
    ]),
  );

/** What leaves the service: masked headers and no OAuth state. */
const redactIntegration = (integration: Integration | StoredIntegration): Integration => {
  const { oauthState: _, browserOrigin: _origin, ...rest } = integration as StoredIntegration;
  return { ...rest, headers: redactHeaders(integration.headers) };
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
  (input.url !== undefined && input.url !== current.url) ||
  (input.transport !== undefined && input.transport !== current.transport) ||
  (input.auth !== undefined &&
    JSON.stringify(input.auth) !== JSON.stringify(current.auth ?? null)) ||
  (input.headers !== undefined &&
    (Object.keys(input.headers).length !== Object.keys(current.headers).length ||
      Object.entries(input.headers).some(
        ([name, value]) => value !== HEADER_MASK && current.headers[name] !== value,
      )));

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
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 60_000;

export class Integrations extends Context.Service<
  Integrations,
  {
    /** Every live integration, unscoped (settings/client view). */
    readonly list: () => Effect.Effect<IntegrationListResult, IntegrationError>;
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
    /** Enabled integrations visible from a project, for the context line. */
    readonly contextIntegrations: (
      labelId: ProjectLabelId | null,
    ) => Effect.Effect<ReadonlyArray<Integration>, IntegrationError>;
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
     * under an unused name, and starts its sign-in when it has one. A sign-in
     * that cannot start leaves the integration saved without a link; it then
     * reads "Needs sign-in" with the reason. A request missing an input fails
     * `invalid_request` with the next step as its cause.
     */
    readonly connectFromCatalog: (
      input: IntegrationCatalogConnectInput,
      options: IntegrationWriteOptions & { readonly origin: SignInOrigin },
    ) => Effect.Effect<IntegrationMutationResult, IntegrationError>;
  }
>()("cogenly-server/integrations/Integrations") {}

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
  client_id_required: "This server needs a client ID from an app you create with the provider.",
};

/** Status text owners and agents see; upstream messages are already bounded. */
const checkMessage = (reason: IntegrationError["reason"], cause: unknown): string => {
  const base = CHECK_MESSAGES[reason] ?? "The request could not be completed.";
  return reason === "upstream_error" && typeof cause === "string" && cause.trim() !== ""
    ? `${base} ${cause.trim().slice(0, MAX_UPSTREAM_MESSAGE_CHARS)}`
    : base;
};

/** One vault item per integration account, named by its id so renames never collide. */
const tokenItemName = (integration: Integration) =>
  `integration-oauth:${integration.id.replace(/^integration:/, "")}`;

const make = (options: IntegrationsOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials.IntegrationCredentials;
    const tokenStore = yield* Tokens.IntegrationTokens;
    const protocol = yield* OAuth.make;
    const local = yield* Effect.serviceOption(Local.LocalIntegrations);
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
    /** Decrypted tokens per signed-in integration, so calls do not reopen the vault. */
    const liveTokens = new Map<
      IntegrationId,
      Tokens.StoredTokens & { readonly itemId: string; readonly expiresAt: number | null }
    >();
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

    const rows = () =>
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM integrations WHERE deleted_at IS NULL ORDER BY name`.pipe(
        Effect.flatMap((found) =>
          Effect.forEach(found, (row) =>
            decode(row.payload_json).pipe(Effect.mapError(failure("list", "storage"))),
          ),
        ),
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
        return yield* decode(found[0].payload_json).pipe(
          Effect.mapError(failure("read", "storage")),
        );
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
     * A managed local account's process and the status it implies. Listing
     * (re)starts an enabled account's process; a failed process is an error,
     * and a running one without a Google grant needs sign-in like remote OAuth.
     */
    const managedState = (integration: StoredIntegration) =>
      Effect.gen(function* () {
        if (integration.transport !== "local" || !integration.enabled || Option.isNone(local))
          return undefined;
        yield* local.value.start(integration).pipe(Effect.ignore);
        const process = yield* local.value.status(integration.id);
        if (process === undefined) return undefined;
        const signedIn = yield* local.value
          .signedIn(integration.id)
          .pipe(Effect.orElseSucceed(() => false));
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

    const summaries = (integrations: ReadonlyArray<StoredIntegration>) =>
      Effect.gen(function* () {
        const entries = yield* Ref.get(cache);
        const checked = yield* Ref.get(checks);
        return {
          integrations: yield* Effect.forEach(integrations, (integration) =>
            Effect.gen(function* () {
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
                  : usesOAuth(integration) && !integration.oauthState?.signedIn
                    ? "needs_sign_in"
                    : failed
                      ? "error"
                      : cached === undefined
                        ? "unknown"
                        : "connected";
              const message =
                (managed?.status === "error" ? managed.process.message : undefined) ??
                current?.message;
              return {
                integration: redactIntegration(integration),
                status,
                toolCount: status === "connected" && cached ? cached.result.tools.length : null,
                ...(message === undefined ? {} : { message }),
                ...(current === undefined ? {} : { checkedAt: current.checkedAt as never }),
                ...(managed === undefined ? {} : { managed: managed.process }),
              } satisfies IntegrationSummary;
            }),
          ),
        };
      });

    /** Records an upstream outcome; clients hear only when the status changes. */
    const recordCheck = (integration: Integration, outcome: { ok: true } | IntegrationError) =>
      Effect.gen(function* () {
        const message = "ok" in outcome ? undefined : checkMessage(outcome.reason, outcome.cause);
        const checkedAt = yield* now;
        const previous = yield* Ref.getAndUpdate(checks, (current) =>
          new Map(current).set(integration.id, {
            updatedAt: integration.updatedAt,
            ok: "ok" in outcome,
            ...(message === undefined ? {} : { message }),
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
      update: (state: OAuthState | undefined) => OAuthState,
      browserOrigin?: string,
    ) =>
      Effect.gen(function* () {
        const current = yield* getById(id);
        // Sign-in state is not an edit: updatedAt, and so the tool cache, stay put.
        yield* persist({
          ...current,
          oauthState: update(current.oauthState),
          ...(browserOrigin === undefined ? {} : { browserOrigin }),
        });
      }).pipe(sql.withTransaction, Effect.mapError(failure("sign in", "storage")));

    /** The grant is gone; only a new browser sign-in helps, so nothing retries it. */
    const markNeedsSignIn = (integration: StoredIntegration, message: string) =>
      Effect.gen(function* () {
        liveTokens.delete(integration.id);
        yield* persistState(integration.id, (state) => ({ ...state, signedIn: false }));
        const checkedAt = yield* now;
        yield* Ref.update(checks, (current) =>
          new Map(current).set(integration.id, {
            updatedAt: integration.updatedAt,
            ok: false,
            message,
            checkedAt,
          }),
        );
        yield* notify;
      }).pipe(Effect.ignore);

    const signInRequired = (operation: string) =>
      new IntegrationError({ operation, reason: "sign_in_required" });

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
        if (live !== undefined && live.itemId === state.tokenItemId) return live;
        const stored = yield* tokenStore.read(state.tokenItemId);
        if (Option.isNone(stored)) return undefined;
        const loaded = {
          ...stored.value,
          itemId: state.tokenItemId,
          expiresAt: state.expiresAt ?? null,
        };
        liveTokens.set(integration.id, loaded);
        return loaded;
      });

    /** The client a token request authenticates as. */
    const oauthClient = (
      integration: StoredIntegration,
      server: OAuth.OAuthServer,
      registration: OAuth.OAuthClientRegistration | undefined,
      registeredSecret: string | undefined,
    ) =>
      Effect.gen(function* () {
        const auth = integration.auth;
        if (auth?.clientId !== undefined) {
          const template = auth.clientSecret?.trim() ?? "";
          if (template === "") return { clientId: auth.clientId, authMethod: "none" as const };
          const endpoint = new URL(integration.url);
          const resolved = yield* resolveHeaderTemplates({ secret: template }, (ref) =>
            credentials.resolve(ref, {
              host: new URL(server.tokenEndpoint).hostname,
              approvedItems:
                integration.credentialOrigin === endpoint.origin
                  ? (integration.approvedCredentialItems ?? [])
                  : [],
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
     */
    const accessToken = (id: IntegrationId, rejected?: string) =>
      Effect.gen(function* () {
        const integration = yield* getById(id);
        const state = integration.oauthState;
        const live = yield* loadTokens(integration);
        if (state?.server === undefined || live === undefined) {
          if (state?.signedIn) yield* markNeedsSignIn(integration, "Sign in again.");
          return yield* signInRequired("authorize");
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const expired = live.expiresAt !== null && live.expiresAt <= nowMs;
        const expiring = live.expiresAt !== null && live.expiresAt - REFRESH_SKEW_MS <= nowMs;
        if (live.accessToken !== rejected && !expiring) return live.accessToken;
        if (live.refreshToken === undefined) {
          if (live.accessToken !== rejected && !expired) return live.accessToken;
          yield* markNeedsSignIn(integration, "The sign-in expired. Sign in again.");
          return yield* signInRequired("authorize");
        }
        const oauth = yield* oauthClient(
          integration,
          state.server,
          state.registration,
          live.clientSecret,
        );
        const refreshed = yield* protocol
          .refresh({
            server: state.server,
            client: oauth,
            refreshToken: live.refreshToken,
            nowMs,
          })
          .pipe(Effect.result);
        if (refreshed._tag === "Failure") {
          if (refreshed.failure.revoked) {
            yield* markNeedsSignIn(
              integration,
              "The sign-in was revoked or expired. Sign in again.",
            );
            return yield* signInRequired("refresh");
          }
          return yield* new IntegrationError({
            operation: "refresh",
            reason: "upstream_error",
            cause: refreshed.failure.message,
          });
        }
        const tokens = refreshed.success;
        const itemId = yield* tokenStore.write({
          itemId: live.itemId,
          name: tokenItemName(integration),
          label: `${integrationTitle(integration)} sign-in`,
          host: new URL(integration.url).hostname,
          tokens: { ...tokens, clientSecret: live.clientSecret },
        });
        liveTokens.set(id, {
          ...tokens,
          clientSecret: live.clientSecret,
          itemId,
          expiresAt: tokens.expiresAt,
        });
        yield* persistState(id, (current) => ({
          ...current,
          signedIn: true,
          tokenItemId: itemId,
          expiresAt: tokens.expiresAt,
        }));
        return tokens.accessToken;
      });

    const post = (
      integration: Integration,
      headers: Record<string, string>,
      method: string,
      params: unknown,
      sessionId: string | undefined,
    ) =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(requestIds, (value) => value + 1);
        let request = HttpClientRequest.post(integration.url).pipe(
          HttpClientRequest.setHeader("content-type", "application/json"),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
        );
        for (const [name, value] of Object.entries(headers)) {
          request = HttpClientRequest.setHeader(request, name, value);
        }
        if (sessionId !== undefined) {
          request = HttpClientRequest.setHeader(request, "mcp-session-id", sessionId);
        }
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
        if (response.status < 200 || response.status >= 300) {
          return yield* new IntegrationError({
            operation: method,
            // Under OAuth a 401 means the token was refused, which a refresh may fix.
            reason:
              usesOAuth(integration) && response.status === 401
                ? "sign_in_required"
                : "upstream_error",
          });
        }
        const body = parseRpcBody(text);
        if (body === undefined) {
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
          });
        }
        if (body.error !== undefined) {
          const message =
            typeof body.error.message === "string"
              ? body.error.message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS)
              : "Upstream MCP error";
          return yield* new IntegrationError({
            operation: method,
            reason: "upstream_error",
            cause: message,
          });
        }
        return {
          result: body.result,
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
                      error.reason === "sign_in_required"
                        ? markNeedsSignIn(
                            integration,
                            "The server refused the sign-in. Sign in again.",
                          )
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
        Effect.tap(() => recordCheck(integration, { ok: true })),
        Effect.tapError((error) =>
          // A refused sign-in recorded its own, more specific status.
          error.reason === "not_found" ||
          error.reason === "disabled" ||
          error.reason === "sign_in_required"
            ? Effect.void
            : recordCheck(integration, error),
        ),
      );

    /** Resolve credentials, handshake, then call. */
    const exchange = (
      integration: Integration,
      method: string,
      params: unknown,
      labelId?: ProjectLabelId | null,
      bearer?: string,
    ) =>
      Effect.gen(function* () {
        if (integration.transport === "local") {
          if (Option.isNone(local))
            return yield* new IntegrationError({
              operation: method,
              reason: "upstream_unreachable",
            });
          return yield* local.value.rpc(integration, method, params, labelId);
        }
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
        return yield* post(integration, headers, method, params, initialized?.sessionId).pipe(
          Effect.map((response) => response.result),
        );
      });

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
      // Process restarts and finished Google sign-ins reach Settings like any other change.
      yield* local.value.changes.pipe(
        Stream.runForEach(() => notify),
        Effect.forkScoped,
      );
    }

    const service: Integrations["Service"] = Integrations.of({
      list: () => rows().pipe(Effect.flatMap(summaries)),
      listForProject: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) => integrationVisibleTo(integration, labelId)),
          ),
          Effect.flatMap(summaries),
        ),
      create: (request, options) =>
        Effect.gen(function* () {
          const input =
            "preset" in request
              ? Option.isSome(local)
                ? yield* local.value.prepare(request)
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
          // A full definition (e.g. an approved proposal) passes the same checks as the preset.
          if (input.transport === "local" && input.local && Option.isSome(local))
            yield* local.value.prepare({
              preset: input.local.preset,
              accountLabel: input.accountLabel?.trim() ?? "",
              callbackOrigin: input.local.callbackOrigin,
            });
          yield* validateUrl(input.url);
          yield* validateAuth(input.auth, "create");
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
          const at = yield* now;
          const integration: Integration = {
            id: IntegrationId.make(
              `integration:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failure("create", "storage")))}`,
            ),
            name: input.name,
            displayName: input.displayName,
            transport: input.transport,
            ...(input.local ? { local: input.local } : {}),
            url: input.url,
            headers: input.headers,
            credentialOrigin: new URL(input.url).origin,
            approvedCredentialItems: options?.approveCredentials
              ? credentialItemsIn(input.headers, input.auth)
              : [],
            enabled: input.enabled ?? true,
            scope: input.scope,
            hint: input.hint,
            ...(input.accountLabel?.trim() ? { accountLabel: input.accountLabel.trim() } : {}),
            ...(input.auth === undefined ? {} : { auth: input.auth }),
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          };
          yield* persist(integration);
          // The process starts now so a sign-in link answers quickly; listing retries a failure.
          if (integration.transport === "local" && Option.isSome(local))
            yield* local.value.start(integration).pipe(Effect.ignore);
          yield* notify;
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
            options?.preserveCredentialDestination &&
            integrationDestinationChanged(current, input)
          ) {
            return yield* new IntegrationError({ operation: "update", reason: "invalid_request" });
          }
          const auth = input.auth === undefined ? current.auth : (input.auth ?? undefined);
          if (
            options?.holdStoredSecrets &&
            integrationDestinationChanged(current, input) &&
            (headersKeepStoredSecrets(current, input.headers ?? current.headers) ||
              credentialRefsIn(auth?.clientSecret ?? "").length > 0)
          ) {
            return yield* new IntegrationError({
              operation: "update",
              reason: "approval_required",
            });
          }
          if (input.url !== undefined) yield* validateUrl(input.url);
          yield* validateAuth(auth, "update");
          const credentialOrigin = options?.preserveCredentialDestination
            ? (current.credentialOrigin ?? new URL(current.url).origin)
            : new URL(input.url ?? current.url).origin;
          const headers = input.headers ?? current.headers;
          const approvedCredentialItems = options?.approveCredentials
            ? credentialItemsIn(headers, auth)
            : credentialOrigin === current.credentialOrigin
              ? (current.approvedCredentialItems ?? [])
              : [];
          // Tokens belong to one server and client: a new URL or client id needs a new sign-in.
          const keepSignIn =
            auth?.type === "oauth" &&
            (input.url === undefined || input.url === current.url) &&
            auth.clientId === current.auth?.clientId;
          const { auth: _auth, accountLabel: _label, oauthState, ...rest } = current;
          const accountLabel =
            input.accountLabel === undefined ? current.accountLabel : input.accountLabel.trim();
          const integration: StoredIntegration = {
            ...rest,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(input.transport === undefined ? {} : { transport: input.transport }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.hint === undefined ? {} : { hint: input.hint }),
            ...(accountLabel ? { accountLabel } : {}),
            ...(auth === undefined ? {} : { auth }),
            ...(keepSignIn && oauthState !== undefined ? { oauthState } : {}),
            updatedAt: yield* now,
            credentialOrigin,
            approvedCredentialItems,
          };
          yield* persist(integration);
          if (!keepSignIn) yield* dropTokens(current);
          yield* invalidate(integration.id);
          return { integration: redactIntegration(integration), changed: true };
        }).pipe(
          sql.withTransaction,
          integrationLock(masked.id).withPermits(1),
          // Once committed, the old process gives way; the next list starts the new version.
          Effect.tap(({ integration, changed }) =>
            changed && integration.transport === "local" && Option.isSome(local)
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
          const at = yield* now;
          const { oauthState: _, ...rest } = current;
          yield* persist({ ...rest, deletedAt: at, updatedAt: at });
          yield* dropTokens(current);
          yield* invalidate(id);
          if (current.transport === "local" && Option.isSome(local)) yield* local.value.stop(id);
          yield* notify;
          return { deleted: true };
        }).pipe(integrationLock(id).withPermits(1), Effect.mapError(failure("delete", "storage"))),
      testConnection: (id) =>
        Effect.gen(function* () {
          const integration = yield* getById(id);
          if (!integration.enabled) {
            return yield* new IntegrationError({
              operation: "test connection",
              reason: "disabled",
            });
          }
          const result = yield* fetchTools(integration).pipe(
            // A passing test is a fresh tool list, so the list view shows it.
            Effect.tap((tools) =>
              Effect.gen(function* () {
                const key = `${integration.id}:${integration.updatedAt}`;
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
                status: error.reason === "sign_in_required" ? "needs_sign_in" : "disconnected",
                toolCount: 0,
                message: `Could not connect (${error.reason}).`,
              }),
            ),
          );
          return result;
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
          const record =
            typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : undefined;
          // A server that echoes its bearer token must not hand it to the agent.
          const live = liveTokens.get(integration.id);
          const content = redactValue(
            result ?? null,
            [live?.accessToken, live?.refreshToken, live?.clientSecret].filter(
              (secret): secret is string => secret !== undefined && secret.length >= 8,
            ),
          );
          return {
            content,
            ...(typeof record?.isError === "boolean" ? { isError: record.isError } : {}),
          } satisfies IntegrationCallResult;
        }),
      contextIntegrations: (labelId) =>
        rows().pipe(
          Effect.map((all) =>
            all.filter((integration) => integrationVisibleTo(integration, labelId)),
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
          const origin = yield* selectCallbackOrigin(from, integration.browserOrigin);
          const redirectUri = `${origin}${OAuth.CALLBACK_PATH}`;
          const server = yield* protocol.discover(integration.url);
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
            // The oldest pending sign-ins give way; their links stop working.
            while (next.size >= MAX_PENDING_SIGN_INS) next.delete(next.keys().next().value!);
            return next.set(state, {
              integrationId: integration.id,
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
            callback.iss !== undefined &&
            callback.iss.replace(/\/+$/, "") !== pending.server.issuer.replace(/\/+$/, "")
          )
            return yield* rejected;
          const integration = yield* getById(pending.integrationId);
          if (
            !integration.enabled ||
            !usesOAuth(integration) ||
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
          const stored =
            previous?.tokenItemId === undefined
              ? Option.none<Tokens.StoredTokens>()
              : yield* tokenStore.read(previous.tokenItemId);
          // A reused registration's secret is the one stored with the earlier sign-in.
          const clientSecret =
            pending.newClientSecret ??
            (pending.registration !== undefined &&
            pending.registration.clientId === previous?.registration?.clientId
              ? Option.getOrUndefined(stored)?.clientSecret
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
          // The exchange does not block edits. Only a current definition may commit
          // its result; stale tokens never enter the vault or an upstream request.
          yield* integrationLock(integration.id).withPermits(1)(
            Effect.gen(function* () {
              const current = yield* getById(integration.id);
              if (!current.enabled || definitionKey(current) !== pending.definition)
                return yield* rejected;
              const itemId = yield* tokenStore.write({
                itemId: previous?.tokenItemId,
                name: tokenItemName(integration),
                label: `${integrationTitle(integration)} sign-in`,
                host: new URL(integration.url).hostname,
                tokens: { ...tokens, clientSecret },
              });
              liveTokens.set(integration.id, {
                ...tokens,
                clientSecret,
                itemId,
                expiresAt: tokens.expiresAt,
              });
              yield* persistState(
                integration.id,
                () => ({
                  signedIn: true,
                  server: pending.server,
                  ...(pending.registration === undefined
                    ? {}
                    : { registration: pending.registration }),
                  tokenItemId: itemId,
                  expiresAt: tokens.expiresAt,
                }),
                new URL(pending.redirectUri).origin,
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
          const resolution = resolveCatalogConnect(request, {
            existingNames: new Set((yield* rows()).map((integration) => integration.name)),
            requestOrigin: options.origin.origin,
          });
          if (resolution._tag === "needs")
            return yield* new IntegrationError({
              operation: "connect from catalog",
              reason: "invalid_request",
              cause: resolution.message,
            });
          const { integration } = yield* service.create(resolution.input, options);
          if (!resolution.signsIn) return { integration };
          const signIn = yield* service
            .beginSignIn(integration.id, {
              ...options.origin,
              callbackOrigin: request.inputs?.callbackOrigin,
            })
            .pipe(Effect.option);
          return Option.isSome(signIn) ? { integration, signIn: signIn.value } : { integration };
        }),
    });
    return service;
  });

type Requirements =
  | SqlClient.SqlClient
  | Crypto.Crypto
  | HttpClient.HttpClient
  | Credentials.IntegrationCredentials
  | Tokens.IntegrationTokens;

export const layerWith = (
  options: IntegrationsOptions,
): Layer.Layer<Integrations, never, Requirements> => Layer.effect(Integrations, make(options));

export const layer: Layer.Layer<Integrations, never, Requirements> = layerWith({});
