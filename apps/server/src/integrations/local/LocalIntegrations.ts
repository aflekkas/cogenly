import * as GoogleTokens from "./GoogleTokenStore.ts";
import {
  IntegrationError,
  IntegrationProvenance,
  Integration,
  type GoogleWorkspaceAddInput,
  type IntegrationCreateInput,
  type IntegrationSignIn,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as Credentials from "../IntegrationCredentials.ts";
import { selectCallbackOrigin, type SignInOrigin } from "../SignInOrigin.ts";
import { isLoopbackHost } from "@cogenly/shared/preview";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { isGrantRejection } from "./GrantRejection.ts";
import { runtimeSearchDirectories } from "./RuntimeInstaller.ts";
import * as Runner from "./LocalMcpRunner.ts";
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_SIGN_IN_PATH,
  GOOGLE_WORKSPACE_VERSION,
  googleWorkspaceInput,
  googleWorkspaceSpec,
  googleClientFromJson,
} from "./GoogleWorkspace.ts";

export class LocalIntegrations extends Context.Service<
  LocalIntegrations,
  {
    readonly prepare: (
      input: GoogleWorkspaceAddInput,
      source?: { readonly fromAgent?: boolean | undefined; readonly origin?: string | undefined },
    ) => Effect.Effect<IntegrationCreateInput, IntegrationError>;
    readonly start: (
      integration: Integration,
      labelId?: ProjectLabelId | null,
    ) => Effect.Effect<void, IntegrationError>;
    readonly rpc: (
      integration: Integration,
      method: string,
      params: unknown,
      labelId?: ProjectLabelId | null,
    ) => Effect.Effect<unknown, IntegrationError>;
    readonly stop: (id: string, replacement?: Integration) => Effect.Effect<void, IntegrationError>;
    /** The process, or why it could not start (`reason`, e.g. no Google client yet). */
    readonly status: (id: string) => Effect.Effect<LocalStatus | undefined>;
    /**
     * The redirect URI Google must list for an account, or for one connected
     * now from `source` (an owner's browser origin, or an agent).
     */
    readonly redirectUri: (
      integration: Integration | undefined,
      source?: { readonly fromAgent?: boolean | undefined; readonly origin?: string | undefined },
    ) => Effect.Effect<string>;
    /** Whether the account's process holds a Google grant. */
    readonly signedIn: (id: string) => Effect.Effect<boolean, IntegrationError>;
    readonly callbackHost: (integration: Integration) => Effect.Effect<string, IntegrationError>;
    readonly signInProvenance: (
      id: string,
    ) => Effect.Effect<Integration["provenance"], IntegrationError>;
    /** A capability link; explicit reauthentication replaces any stored grant. */
    readonly signInLink: (
      integration: Integration,
      reauthenticate?: boolean,
      from?: SignInOrigin,
    ) => Effect.Effect<IntegrationSignIn | undefined, IntegrationError>;
    /** Fires when a process changes state, a start fails differently, or a sign-in lands. */
    readonly changes: Stream.Stream<void>;
    readonly authorize: (
      ticket: string,
    ) => Effect.Effect<{ readonly url?: string; readonly connected: boolean }, IntegrationError>;
    readonly credentialRequest: (
      capability: string,
      input: unknown,
    ) => Effect.Effect<unknown, IntegrationError>;
    readonly callback: (query: string) => Effect.Effect<boolean, IntegrationError>;
  }
>()("cogenly-server/integrations/local/LocalIntegrations") {}

export type LocalStatus = Runner.LocalMcpStatus & {
  readonly reason?: IntegrationError["reason"] | undefined;
};

/** What a managed account's row says while it has no Google client to start with. */
export const GOOGLE_CLIENT_MISSING_MESSAGE =
  "Google needs your own OAuth client before this account can start.";

const AuthResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
});
const isStartGoogleAuth = Schema.is(Schema.Struct({ name: Schema.Literal("start_google_auth") }));
const decodeAuthResult = Schema.decodeUnknownOption(AuthResult);
const browserOriginJson = Schema.fromJsonString(Schema.String);
const decodeBrowserOrigin = Schema.decodeUnknownEffect(browserOriginJson);
const encodeBrowserOrigin = Schema.encodeEffect(browserOriginJson);
const decodeSignInProvenance = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IntegrationProvenance),
);
const encodeSignInProvenance = Schema.encodeEffect(Schema.fromJsonString(IntegrationProvenance));
const AUTH_LIFETIME_MS = 10 * 60_000;
const definitionKey = Schema.encodeSync(Schema.fromJsonString(Integration));
const mapLocalError = (cause: Runner.LocalMcpError) =>
  new IntegrationError({
    operation: "run local server",
    reason:
      cause.reason === "missing_runtime"
        ? "local_runtime_missing"
        : cause.reason === "sign_in_required"
          ? "sign_in_required"
          : cause.reason === "protocol"
            ? "upstream_error"
            : "upstream_unreachable",
    cause: cause.reason === "protocol" && typeof cause.cause === "string" ? cause.cause : cause,
  });

const make = Effect.gen(function* () {
  const runner = yield* Runner.LocalMcpRunner;
  const googleTokens = yield* GoogleTokens.GoogleTokenStore;
  const credentialCapabilities = new Map<string, string>();
  const tokenRedactions = new Map<string, string[]>();
  const rememberTokens = (id: string, grant: GoogleTokens.GoogleGrant) => {
    const values = tokenRedactions.get(id);
    for (const token of [
      grant.credentials.token,
      grant.credentials.refresh_token,
      grant.credentials.client_secret,
    ]) {
      if (token && values && !values.includes(token)) values.push(token);
    }
  };
  const credentials = yield* Credentials.IntegrationCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const authLock = yield* Semaphore.make(1);
  const failures = new Map<string, LocalStatus>();
  const ownChanges = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(ownChanges, undefined).pipe(Effect.asVoid);
  const configuredOrigin = yield* Config.String("COGENLY_GOOGLE_CALLBACK_ORIGIN").pipe(
    Config.withDefault(""),
    Effect.orDie,
  );
  const ambient = yield* Config.all({
    PATH: Config.String("PATH").pipe(Config.withDefault("")),
    HOME: Config.String("HOME").pipe(Config.withDefault("")),
    TMPDIR: Config.String("TMPDIR").pipe(Config.withDefault("/tmp")),
    SYSTEMROOT: Config.String("SYSTEMROOT").pipe(Config.withDefault("")),
  }).pipe(Effect.orDie);
  const platform = yield* HostProcess.Platform;
  const delimiter = platform === "win32" ? ";" : ":";
  // uv's install directories too, so installing it from Settings works without a restart.
  const environment = {
    ...ambient,
    PATH: [
      ...new Set(
        [
          ...ambient.PATH.split(delimiter),
          ...(ambient.HOME === "" ? [] : runtimeSearchDirectories(platform, ambient.HOME)),
        ].filter((directory) => directory !== ""),
      ),
    ].join(delimiter),
  };
  const tickets = new Map<
    string,
    { readonly integration: Integration; readonly expires: number; readonly fromAgent: boolean }
  >();
  const states = new Map<
    string,
    {
      readonly integration: Integration;
      readonly expires: number;
      readonly url: string;
      readonly fromAgent: boolean;
    }
  >();
  const active = new Map<string, ProjectLabelId | null | undefined>();
  // In-flight requests may still hold an old definition after a committed edit or deletion.
  // Only the replacement supplied by that mutation may start the account again.
  const replacements = new Map<string, string | null>();
  const isCurrent = (integration: Integration) =>
    !replacements.has(integration.id) ||
    replacements.get(integration.id) === definitionKey(integration);
  const directoryFor = (id: string) =>
    path.join(config.stateDir, "integrations", "local", encodeURIComponent(id));
  const credentialsFor = (id: string) => path.join(directoryFor(id), "credentials");
  const storageError = (cause: unknown) =>
    new IntegrationError({ operation: "manage local integration", reason: "storage", cause });
  const validOrigin = (raw: string) =>
    Effect.try({
      try: () => {
        const url = new URL(raw);
        if (
          url.origin !== raw ||
          url.username ||
          url.password ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error("Invalid callback origin");
        return url.origin;
      },
      catch: () =>
        new IntegrationError({
          operation: "validate Google callback origin (use HTTPS, or localhost on this machine)",
          reason: "invalid_request",
        }),
    });
  const credentialError = (
    cause:
      | Credentials.IntegrationCredentialError
      | Credentials.IntegrationCredentialNotAllowedError,
  ) =>
    new IntegrationError({
      operation: "resolve Google client",
      reason:
        cause._tag === "IntegrationCredentialNotAllowedError"
          ? "credential_not_allowed"
          : "google_client_missing",
      cause,
    });
  const client = (labelId?: ProjectLabelId | null) =>
    Effect.gen(function* () {
      const destination: Credentials.CredentialDestination = {
        host: "accounts.google.com",
        scopeProjectId: labelId,
        approvedItems: [],
      };
      const json = yield* credentials
        .resolve("google-oauth-client.value", destination)
        .pipe(Effect.mapError(credentialError));
      if (json._tag === "Some") {
        const decoded = googleClientFromJson(json.value);
        if (decoded._tag === "Some") return decoded.value;
      }
      const id = yield* credentials
        .resolve("google-oauth-client.username", destination)
        .pipe(Effect.mapError(credentialError));
      const secret = yield* credentials
        .resolve("google-oauth-client.password", destination)
        .pipe(Effect.mapError(credentialError));
      if (id._tag === "None" || secret._tag === "None" || !id.value || !secret.value)
        return yield* new IntegrationError({
          operation: "connect Google",
          reason: "google_client_missing",
        });
      return { clientId: id.value, clientSecret: secret.value };
    });
  const browserOriginFile = (id: string) => path.join(directoryFor(id), "browser-origin.json");
  const signInProvenance = (id: string) =>
    Effect.gen(function* () {
      const file = path.join(directoryFor(id), "sign-in.json");
      if (!(yield* fs.exists(file))) return undefined;
      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeSignInProvenance));
    }).pipe(Effect.mapError(storageError));
  const activeOrigins = new Map<string, string>();
  const readBrowserOrigin = (id: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(browserOriginFile(id)))) return undefined;
      return yield* fs
        .readFileString(browserOriginFile(id))
        .pipe(Effect.flatMap(decodeBrowserOrigin));
    }).pipe(Effect.mapError(storageError));
  const originFor = (integration: Integration) =>
    Effect.gen(function* () {
      return (
        (configuredOrigin || undefined) ??
        activeOrigins.get(integration.id) ??
        (yield* readBrowserOrigin(integration.id)) ??
        integration.local!.callbackOrigin
      );
    });
  const rejectedGrants = new Set<string>();
  const rejectGrant = (id: string) =>
    Effect.gen(function* () {
      if (rejectedGrants.has(id)) return;
      rejectedGrants.add(id);
      yield* fs
        .writeFileString(path.join(directoryFor(id), "grant-rejected"), "", { mode: 0o600 })
        .pipe(Effect.mapError(storageError));
      yield* changed;
    });
  const signedIn = (id: string) =>
    Effect.gen(function* () {
      if ((yield* runner.status(id))?.grantRejected) yield* rejectGrant(id);
      return (
        !rejectedGrants.has(id) &&
        !(yield* fs
          .exists(path.join(directoryFor(id), "grant-rejected"))
          .pipe(Effect.mapError(storageError))) &&
        (yield* hasCredentials(id))
      );
    });
  const hasCredentials = (id: string) =>
    googleTokens
      .read(id)
      .pipe(
        Effect.map(
          (grant) => grant._tag === "Some" && Boolean(grant.value.credentials.refresh_token),
        ),
      );
  const prune = (now: number) => {
    for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
    for (const [key, state] of states) if (state.expires <= now) states.delete(key);
  };
  const start = (integration: Integration, labelId?: ProjectLabelId | null) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!isCurrent(integration))
          return yield* new IntegrationError({
            operation: "start retired local integration",
            reason: "not_found",
          });
        if (
          !integration.enabled ||
          integration.deletedAt !== null ||
          (integration.transport !== "stdio" &&
            (integration.local?.preset !== "google-workspace" ||
              integration.local.version !== GOOGLE_WORKSPACE_VERSION))
        )
          return yield* new IntegrationError({
            operation: "start local integration",
            reason: "invalid_request",
          });
        if (active.has(integration.id)) {
          const state = (yield* runner.status(integration.id))?.state;
          if (
            active.get(integration.id) === labelId &&
            (state === "running" || state === "starting" || state === "failed")
          )
            return;
          // A process holds the credentials resolved for its starting project.
          // Never reuse them for a different caller, including the owner view.
          yield* runner.stop(integration.id);
          active.delete(integration.id);
        }
        if (integration.transport === "stdio") {
          const command = integration.command;
          if (!command || command.args.includes("<reenter-reviewed-arguments>"))
            return yield* new IntegrationError({
              operation: "restore reviewed command arguments",
              reason: "invalid_request",
            });
          const env: Record<string, string> = { ...environment };
          const secrets: string[] = [];
          for (const [key, template] of Object.entries(command.env)) {
            let value = template;
            for (const match of template.matchAll(/\{\{credential:([^}]*)\}\}/g)) {
              const ref = match[1]!;
              if (!Credentials.parseCredentialRef(ref))
                return yield* new IntegrationError({
                  operation: "resolve stdio environment",
                  reason: "credential_unresolved",
                });
              const secret = yield* credentials
                .resolve(ref, {
                  host: "localhost",
                  scopeProjectId: labelId,
                  approvedItems: integration.approvedCredentialItems ?? [],
                })
                .pipe(Effect.mapError(credentialError));
              if (secret._tag === "None")
                return yield* new IntegrationError({
                  operation: "resolve stdio environment",
                  reason: "credential_unresolved",
                });
              value = value.replaceAll(match[0], () => secret.value);
              secrets.push(secret.value);
            }
            if (value.includes("{{"))
              return yield* new IntegrationError({
                operation: "resolve stdio environment",
                reason: "credential_unresolved",
              });
            env[key] = value;
          }
          yield* runner
            .start({
              id: integration.id,
              runtime: command.command,
              args: command.args,
              version: "custom",
              directory: directoryFor(integration.id),
              env,
              secrets,
              transport: "stdio",
              port: 0,
              idleTimeoutMs: 5 * 60_000,
            })
            .pipe(Effect.mapError(mapLocalError));
          active.set(integration.id, labelId);
          return;
        }
        const secrets = yield* client(labelId);
        const callbackOrigin = yield* originFor(integration).pipe(Effect.flatMap(validOrigin));
        const directory = directoryFor(integration.id);
        const credentialsDirectory = credentialsFor(integration.id);
        for (const dir of [directory, credentialsDirectory, path.join(directory, "logs")]) {
          yield* fs
            .makeDirectory(dir, { recursive: true, mode: 0o700 })
            .pipe(Effect.mapError(storageError));
          yield* fs.chmod(dir, 0o700).pipe(Effect.mapError(storageError));
        }
        // The pinned package always installs a second, unsanitized file handler.
        // Discard that copy; retain only the runner's bounded, redacted output.
        const logFile = path.join(directory, "logs", "mcp_server_debug.log");
        yield* fs.remove(logFile, { force: true }).pipe(Effect.mapError(storageError));
        yield* fs
          .symlink(path.sep === "\\" ? "\\\\.\\NUL" : "/dev/null", logFile)
          .pipe(Effect.mapError(storageError));
        const capability = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
        for (const [key, id] of credentialCapabilities)
          if (id === integration.id) credentialCapabilities.delete(key);
        credentialCapabilities.set(capability, integration.id);
        const spec = googleWorkspaceSpec({
          credentialBridge: {
            url: `http://127.0.0.1:${config.port}/oauth/integrations/google/credentials`,
            capability,
          },
          id: integration.id,
          directory,
          credentialsDirectory,
          port: yield* Runner.freeLoopbackPort.pipe(Effect.mapError(mapLocalError)),
          callbackOrigin,
          ...secrets,
          environment,
        });
        const processSecrets = [...spec.secrets];
        tokenRedactions.set(integration.id, processSecrets);
        const grant = yield* googleTokens.read(integration.id);
        if (grant._tag === "Some") rememberTokens(integration.id, grant.value);
        yield* runner
          .start({ ...spec, secrets: processSecrets })
          .pipe(Effect.mapError(mapLocalError));
        active.set(integration.id, labelId);
        if (failures.delete(integration.id)) yield* changed;
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            if (!isCurrent(integration)) return;
            const message =
              error.reason === "google_client_missing"
                ? GOOGLE_CLIENT_MISSING_MESSAGE
                : error.message;
            // Lists retry the start; only a new reason is news, or listeners would loop.
            const unchanged = failures.get(integration.id)?.message === message;
            failures.set(integration.id, {
              state: error.reason === "local_runtime_missing" ? "missing_runtime" : "failed",
              version: integration.local?.version ?? GOOGLE_WORKSPACE_VERSION,
              stderrTail: "",
              message,
              reason: error.reason,
            });
            if (!unchanged) yield* changed;
          }),
        ),
      ),
    );
  const rememberAuth = (integration: Integration, result: unknown, fromAgent: boolean) =>
    Effect.gen(function* () {
      if (!isCurrent(integration)) return;
      const decoded = decodeAuthResult(result);
      if (decoded._tag === "None") return;
      const now = yield* Clock.currentTimeMillis;
      prune(now);
      for (const block of decoded.value.content) {
        for (const match of (block.text ?? "").matchAll(
          /https:\/\/accounts\.google\.com\/[^\s<>"\])]+/g,
        )) {
          const url = new URL(match[0]);
          const state = url.searchParams.get("state");
          if (
            !state ||
            url.searchParams.get("redirect_uri") !==
              `${yield* originFor(integration)}${GOOGLE_CALLBACK_PATH}`
          )
            continue;
          if ([...states.values()].filter((entry) => entry.fromAgent === fromAgent).length >= 1000)
            return;
          states.set(state, {
            integration,
            expires: now + AUTH_LIFETIME_MS,
            url: url.href,
            fromAgent,
          });
        }
      }
    });
  const rpc = (
    integration: Integration,
    method: string,
    params: unknown,
    labelId?: ProjectLabelId | null,
    allowSignIn = false,
    fromAgent = false,
  ) =>
    Effect.gen(function* () {
      const signingIn = method === "tools/call" && isStartGoogleAuth(params);
      if (signingIn && !allowSignIn)
        return yield* new IntegrationError({
          operation: "start Google sign-in through Settings",
          reason: "approval_required",
        });
      yield* start(integration, labelId);
      const result = yield* runner.rpc(integration.id, method, params).pipe(
        Effect.mapError(mapLocalError),
        Effect.tapError((error) =>
          error.reason === "sign_in_required" ? rejectGrant(integration.id) : Effect.void,
        ),
      );
      const decoded = decodeAuthResult(result);
      if (
        decoded._tag === "Some" &&
        decoded.value.content.some((block) => isGrantRejection(block.text ?? ""))
      ) {
        yield* rejectGrant(integration.id);
        return yield* new IntegrationError({
          operation: "Google authorization",
          reason: "sign_in_required",
        });
      }
      if (signingIn && allowSignIn) yield* rememberAuth(integration, result, fromAgent);
      return result;
    });
  return LocalIntegrations.of({
    prepare: (input, source) =>
      Effect.gen(function* () {
        const origin = yield* validOrigin(
          configuredOrigin ||
            input.callbackOrigin ||
            (source?.fromAgent
              ? `http://localhost:${config.port}`
              : (source?.origin ?? input.callbackOrigin ?? `http://localhost:${config.port}`)),
        );
        yield* client();
        return googleWorkspaceInput({ ...input, callbackOrigin: origin }, origin);
      }),
    start,
    rpc,
    stop: (id, replacement) =>
      authLock.withPermits(1)(
        lock.withPermits(1)(
          Effect.gen(function* () {
            replacements.set(id, replacement ? definitionKey(replacement) : null);
            active.delete(id);
            for (const [key, account] of credentialCapabilities)
              if (account === id) credentialCapabilities.delete(key);
            failures.delete(id);
            for (const [key, ticket] of tickets)
              if (ticket.integration.id === id) tickets.delete(key);
            for (const [key, state] of states) if (state.integration.id === id) states.delete(key);
            yield* runner.stop(id);
            tokenRedactions.delete(id);
            if (replacement === undefined) {
              yield* fs
                .remove(directoryFor(id), { recursive: true, force: true })
                .pipe(Effect.mapError(storageError));
              activeOrigins.delete(id);
              rejectedGrants.delete(id);
              yield* googleTokens.remove(id);
              for (const [key, account] of credentialCapabilities)
                if (account === id) credentialCapabilities.delete(key);
            }
          }),
        ),
      ),
    status: (id) =>
      runner
        .status(id)
        .pipe(Effect.map((status): LocalStatus | undefined => status ?? failures.get(id))),
    redirectUri: (integration, source) =>
      Effect.gen(function* () {
        const origin =
          integration === undefined
            ? configuredOrigin ||
              source?.origin ||
              (source?.fromAgent
                ? `http://localhost:${config.port}`
                : (source?.origin ?? `http://localhost:${config.port}`))
            : yield* originFor(integration).pipe(
                Effect.orElseSucceed(() => integration.local?.callbackOrigin ?? ""),
              );
        return `${URL.parse(origin)?.origin ?? origin}${GOOGLE_CALLBACK_PATH}`;
      }),
    signedIn,
    signInProvenance,
    callbackHost: (integration) =>
      originFor(integration).pipe(Effect.map((origin) => new URL(origin).host)),
    changes: Stream.merge(
      runner.changes.pipe(
        Stream.mapEffect((event) =>
          event.status.grantRejected ? rejectGrant(event.id).pipe(Effect.ignore) : Effect.void,
        ),
      ),
      Stream.fromPubSub(ownChanges),
    ),
    signInLink: (integration, reauthenticate = false, from) =>
      authLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            !isCurrent(integration) ||
            !integration.enabled ||
            integration.deletedAt !== null ||
            !integration.local ||
            (!reauthenticate && (yield* signedIn(integration.id)))
          )
            return undefined;
          const previousOrigin = yield* originFor(integration);
          const known = yield* readBrowserOrigin(integration.id);
          const configured = integration.local.callbackOrigin;
          const publicConfigured = !isLoopbackHost(new URL(configured).hostname);
          const origin = yield* selectCallbackOrigin(
            {
              ...from,
              callbackOrigin:
                (configuredOrigin || undefined) ??
                known ??
                (publicConfigured ? configured : from?.callbackOrigin),
              origin: from?.fromAgent
                ? undefined
                : (known ?? (publicConfigured ? configured : (from?.origin ?? configured))),
            },
            (configuredOrigin || undefined) ?? known ?? (publicConfigured ? configured : undefined),
          ).pipe(Effect.flatMap(validOrigin));
          const replaceCredentials = reauthenticate && (yield* hasCredentials(integration.id));
          activeOrigins.set(integration.id, origin);
          // Only an explicit sign-in retires the vault grant. A changed
          // callback also needs a fresh process with the matching redirect URI.
          if (replaceCredentials || origin !== previousOrigin) {
            yield* runner.stop(integration.id);
            active.delete(integration.id);
            if (replaceCredentials) yield* googleTokens.remove(integration.id);
            for (const [key, ticket] of tickets)
              if (ticket.integration.id === integration.id) tickets.delete(key);
            for (const [key, state] of states)
              if (state.integration.id === integration.id) states.delete(key);
            yield* start(integration);
          }
          const link = (ticket: string): IntegrationSignIn => ({
            authorizationUrl: `${origin}${GOOGLE_SIGN_IN_PATH}?ticket=${ticket}`,
            redirectUri: `${origin}${GOOGLE_CALLBACK_PATH}`,
          });
          const now = yield* Clock.currentTimeMillis;
          prune(now);
          for (const [ticket, entry] of tickets)
            if (
              entry.integration.id === integration.id &&
              entry.fromAgent === (from?.fromAgent === true)
            )
              return link(ticket);
          if (
            [...tickets.values()].filter((entry) => entry.fromAgent === (from?.fromAgent === true))
              .length >= 1000
          )
            return undefined;
          const ticket = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
          tickets.set(ticket, {
            integration,
            expires: now + AUTH_LIFETIME_MS,
            fromAgent: from?.fromAgent === true,
          });
          return link(ticket);
        }),
      ),
    authorize: (ticket) =>
      authLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          prune(now);
          const entry = tickets.get(ticket);
          if (!entry)
            return yield* new IntegrationError({
              operation: "start Google sign-in (link expired; start sign-in again)",
              reason: "not_found",
            });
          if (yield* signedIn(entry.integration.id)) return { connected: true };
          const pending = [...states.values()].find(
            (state) =>
              state.integration.id === entry.integration.id && state.fromAgent === entry.fromAgent,
          );
          if (pending) return { connected: false, url: pending.url };
          yield* rpc(
            entry.integration,
            "tools/call",
            {
              name: "start_google_auth",
              arguments: { service_name: "Google Workspace", user_google_email: "default" },
            },
            undefined,
            true,
            entry.fromAgent,
          );
          const auth = [...states.values()].find(
            (state) =>
              state.integration.id === entry.integration.id && state.fromAgent === entry.fromAgent,
          );
          if (!auth)
            return yield* new IntegrationError({
              operation: "start Google sign-in",
              reason: "upstream_error",
            });
          return { connected: false, url: auth.url };
        }),
      ),
    credentialRequest: (capability, input) =>
      Effect.gen(function* () {
        const id = credentialCapabilities.get(capability);
        if (!id)
          return yield* new IntegrationError({
            operation: "authorize credential bridge",
            reason: "not_found",
          });
        const request = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            operation: Schema.Literals(["read", "write", "remove"]),
            grant: Schema.optional(GoogleTokens.GoogleGrant),
          }),
        )(input).pipe(Effect.mapError(storageError));
        if (request.operation === "read") {
          const grant = yield* googleTokens.read(id);
          if (grant._tag === "Some") rememberTokens(id, grant.value);
          return { grant: Option.getOrNull(grant) };
        }
        if (request.operation === "remove") {
          yield* googleTokens.remove(id);
          return { ok: true };
        }
        if (!request.grant)
          return yield* new IntegrationError({
            operation: "write Google grant",
            reason: "invalid_request",
          });
        rememberTokens(id, request.grant);
        yield* googleTokens.write(id, request.grant);
        return { ok: true };
      }),
    callback: (query) =>
      Effect.gen(function* () {
        const received = new URLSearchParams(query);
        const params = new URLSearchParams();
        for (const key of ["code", "state", "scope", "error"]) {
          const values = received.getAll(key);
          if (values.length > 1) return false;
          if (values[0] !== undefined) params.set(key, values[0]);
        }
        const state = params.get("state");
        const entry = state ? states.get(state) : undefined;
        if (
          !entry ||
          entry.expires <= (yield* Clock.currentTimeMillis) ||
          !params.get("code") ||
          params.has("error")
        )
          return false;
        // Consume before forwarding: an uncertain exchange is never replayed automatically.
        states.delete(state!);
        const success = yield* runner
          .callback(entry.integration.id, params.toString())
          .pipe(Effect.mapError(mapLocalError));
        const connected = success && (yield* hasCredentials(entry.integration.id));
        if (connected) {
          for (const [key, pending] of states)
            if (pending.integration.id === entry.integration.id) states.delete(key);
          const provenance = {
            signedInAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            signedInViaAgent: entry.fromAgent,
          };
          yield* fs
            .writeFileString(
              path.join(directoryFor(entry.integration.id), "sign-in.json"),
              yield* encodeSignInProvenance(provenance).pipe(Effect.mapError(storageError)),
              { mode: 0o600 },
            )
            .pipe(Effect.mapError(storageError));
          const redirect = new URL(entry.url).searchParams.get("redirect_uri")!;
          yield* fs
            .writeFileString(
              browserOriginFile(entry.integration.id),
              yield* encodeBrowserOrigin(new URL(redirect).origin).pipe(
                Effect.mapError(storageError),
              ),
              { mode: 0o600 },
            )
            .pipe(Effect.mapError(storageError));
          rejectedGrants.delete(entry.integration.id);
          yield* fs
            .remove(path.join(directoryFor(entry.integration.id), "grant-rejected"), {
              force: true,
            })
            .pipe(Effect.mapError(storageError));
          yield* changed;
        }
        return connected;
      }).pipe(authLock.withPermits(1)),
  });
});

export const layer = Layer.effect(LocalIntegrations, make);
