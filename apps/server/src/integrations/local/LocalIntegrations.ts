import {
  IntegrationError,
  Integration,
  type GoogleWorkspaceAddInput,
  type IntegrationCreateInput,
  type IntegrationSignIn,
  type ProjectLabelId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as Credentials from "../IntegrationCredentials.ts";
import { selectCallbackOrigin, type SignInOrigin } from "../SignInOrigin.ts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { isGrantRejection } from "./GrantRejection.ts";
import * as Runner from "./LocalMcpRunner.ts";
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_CLIENT_HELP,
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
    readonly status: (id: string) => Effect.Effect<Runner.LocalMcpStatus | undefined>;
    /** Whether the account's process holds a Google grant. */
    readonly signedIn: (id: string) => Effect.Effect<boolean, IntegrationError>;
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
    readonly callback: (query: string) => Effect.Effect<boolean, IntegrationError>;
  }
>()("cogenly-server/integrations/local/LocalIntegrations") {}

const AuthResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
});
const decodeAuthResult = Schema.decodeUnknownOption(AuthResult);
const decodeToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ refresh_token: Schema.String })),
);
const browserOriginJson = Schema.fromJsonString(Schema.String);
const decodeBrowserOrigin = Schema.decodeUnknownEffect(browserOriginJson);
const encodeBrowserOrigin = Schema.encodeEffect(browserOriginJson);
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
          : "upstream_unreachable",
    cause,
  });

const make = Effect.gen(function* () {
  const runner = yield* Runner.LocalMcpRunner;
  const credentials = yield* Credentials.IntegrationCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const authLock = yield* Semaphore.make(1);
  const failures = new Map<string, Runner.LocalMcpStatus>();
  const ownChanges = yield* PubSub.unbounded<void>();
  const changed = PubSub.publish(ownChanges, undefined).pipe(Effect.asVoid);
  const configuredOrigin = yield* Config.String("COGENLY_GOOGLE_CALLBACK_ORIGIN").pipe(
    Config.withDefault(`http://localhost:${config.port}`),
    Effect.orDie,
  );
  const environment = yield* Config.all({
    PATH: Config.String("PATH").pipe(Config.withDefault("")),
    HOME: Config.String("HOME").pipe(Config.withDefault("")),
    TMPDIR: Config.String("TMPDIR").pipe(Config.withDefault("/tmp")),
    SYSTEMROOT: Config.String("SYSTEMROOT").pipe(Config.withDefault("")),
  }).pipe(Effect.orDie);
  const tickets = new Map<
    string,
    { readonly integration: Integration; readonly expires: number }
  >();
  const states = new Map<
    string,
    { readonly integration: Integration; readonly expires: number; readonly url: string }
  >();
  const active = new Set<string>();
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
    Effect.gen(function* () {
      const directory = credentialsFor(id);
      if (!(yield* fs.exists(directory))) return false;
      for (const file of yield* fs.readDirectory(directory)) {
        if (!file.endsWith(".json") || file === "oauth_states.json") continue;
        const decoded = decodeToken(yield* fs.readFileString(path.join(directory, file)));
        if (decoded._tag === "Some" && decoded.value.refresh_token) return true;
      }
      return false;
    }).pipe(Effect.mapError(storageError));
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
          integration.local?.preset !== "google-workspace" ||
          integration.local.version !== GOOGLE_WORKSPACE_VERSION
        )
          return yield* new IntegrationError({
            operation: "start local integration",
            reason: "invalid_request",
          });
        if (active.has(integration.id)) return;
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
        const spec = googleWorkspaceSpec({
          id: integration.id,
          directory,
          credentialsDirectory,
          port: yield* Runner.freeLoopbackPort.pipe(Effect.mapError(mapLocalError)),
          callbackOrigin,
          ...secrets,
          environment,
        });
        yield* runner.start(spec).pipe(Effect.mapError(mapLocalError));
        active.add(integration.id);
        if (failures.delete(integration.id)) yield* changed;
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            if (!isCurrent(integration)) return;
            const message =
              error.reason === "google_client_missing" ? GOOGLE_CLIENT_HELP : error.message;
            // Lists retry the start; only a new reason is news, or listeners would loop.
            const unchanged = failures.get(integration.id)?.message === message;
            failures.set(integration.id, {
              state: "failed",
              version: integration.local?.version ?? GOOGLE_WORKSPACE_VERSION,
              stderrTail: "",
              message,
            });
            if (!unchanged) yield* changed;
          }),
        ),
      ),
    );
  const rememberAuth = (integration: Integration, result: unknown) =>
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
          if (states.size >= 1000) return;
          states.set(state, { integration, expires: now + AUTH_LIFETIME_MS, url: url.href });
        }
      }
    });
  const rpc = (
    integration: Integration,
    method: string,
    params: unknown,
    labelId?: ProjectLabelId | null,
  ) =>
    Effect.gen(function* () {
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
      yield* rememberAuth(integration, result);
      return result;
    });
  return LocalIntegrations.of({
    prepare: (input) =>
      Effect.gen(function* () {
        const origin = yield* validOrigin(input.callbackOrigin ?? configuredOrigin);
        yield* client();
        return googleWorkspaceInput(input, origin);
      }),
    start,
    rpc,
    stop: (id, replacement) =>
      authLock.withPermits(1)(
        lock.withPermits(1)(
          Effect.gen(function* () {
            replacements.set(id, replacement ? definitionKey(replacement) : null);
            active.delete(id);
            failures.delete(id);
            for (const [key, ticket] of tickets)
              if (ticket.integration.id === id) tickets.delete(key);
            for (const [key, state] of states) if (state.integration.id === id) states.delete(key);
            yield* runner.stop(id);
            if (replacement === undefined) {
              yield* fs
                .remove(directoryFor(id), { recursive: true, force: true })
                .pipe(Effect.mapError(storageError));
              activeOrigins.delete(id);
              rejectedGrants.delete(id);
            }
          }),
        ),
      ),
    status: (id) => runner.status(id).pipe(Effect.map((status) => status ?? failures.get(id))),
    signedIn,
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
              origin: from?.fromAgent
                ? from.origin
                : (known ?? (publicConfigured ? configured : (from?.origin ?? configured))),
            },
            known ?? (publicConfigured ? configured : undefined),
          ).pipe(Effect.flatMap(validOrigin));
          const replaceCredentials = reauthenticate && (yield* hasCredentials(integration.id));
          activeOrigins.set(integration.id, origin);
          // Only an explicit sign-in retires the on-disk grant. A changed
          // callback also needs a fresh process with the matching redirect URI.
          if (replaceCredentials || origin !== previousOrigin) {
            yield* runner.stop(integration.id);
            active.delete(integration.id);
            if (replaceCredentials) {
              const backup = `${credentialsFor(integration.id)}.previous`;
              yield* fs
                .remove(backup, { recursive: true, force: true })
                .pipe(Effect.mapError(storageError));
              yield* fs
                .rename(credentialsFor(integration.id), backup)
                .pipe(Effect.mapError(storageError));
            }
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
            if (entry.integration.id === integration.id) return link(ticket);
          if (tickets.size >= 1000) return undefined;
          const ticket = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
          tickets.set(ticket, { integration, expires: now + AUTH_LIFETIME_MS });
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
            (state) => state.integration.id === entry.integration.id,
          );
          if (pending) return { connected: false, url: pending.url };
          yield* rpc(entry.integration, "tools/call", {
            name: "start_google_auth",
            arguments: { service_name: "Google Workspace", user_google_email: "default" },
          });
          const auth = [...states.values()].find(
            (state) => state.integration.id === entry.integration.id,
          );
          if (!auth)
            return yield* new IntegrationError({
              operation: "start Google sign-in",
              reason: "upstream_error",
            });
          return { connected: false, url: auth.url };
        }),
      ),
    callback: (query) =>
      Effect.gen(function* () {
        const params = new URLSearchParams(query);
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
