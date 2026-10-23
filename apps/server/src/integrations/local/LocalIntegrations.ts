import {
  IntegrationError,
  Integration,
  type GoogleWorkspaceAddInput,
  type IntegrationCreateInput,
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../../config.ts";
import * as Credentials from "../IntegrationCredentials.ts";
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
    readonly stop: (id: string, replacement?: Integration) => Effect.Effect<void>;
    readonly status: (id: string) => Effect.Effect<Runner.LocalMcpStatus | undefined>;
    readonly signInLink: (
      integration: Integration,
    ) => Effect.Effect<string | undefined, IntegrationError>;
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
const AUTH_LIFETIME_MS = 10 * 60_000;
const definitionKey = Schema.encodeSync(Schema.fromJsonString(Integration));
const mapLocalError = (cause: Runner.LocalMcpError) =>
  new IntegrationError({
    operation: "run local server",
    reason: cause.reason === "missing_runtime" ? "local_runtime_missing" : "upstream_unreachable",
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
        yield* validOrigin(integration.local.callbackOrigin);
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
          callbackOrigin: integration.local.callbackOrigin,
          ...secrets,
          environment,
        });
        yield* runner.start(spec).pipe(Effect.mapError(mapLocalError));
        active.add(integration.id);
        failures.delete(integration.id);
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (!isCurrent(integration)) return;
            failures.set(integration.id, {
              state: "failed",
              version: integration.local?.version ?? GOOGLE_WORKSPACE_VERSION,
              stderrTail: "",
              message:
                error.reason === "google_client_missing" ? GOOGLE_CLIENT_HELP : error.message,
            });
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
              `${integration.local?.callbackOrigin}${GOOGLE_CALLBACK_PATH}`
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
      const result = yield* runner
        .rpc(integration.id, method, params)
        .pipe(Effect.mapError(mapLocalError));
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
          }),
        ),
      ),
    status: (id) => runner.status(id).pipe(Effect.map((status) => status ?? failures.get(id))),
    signInLink: (integration) =>
      authLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            !isCurrent(integration) ||
            !integration.enabled ||
            integration.deletedAt !== null ||
            !integration.local ||
            (yield* hasCredentials(integration.id))
          )
            return undefined;
          const now = yield* Clock.currentTimeMillis;
          prune(now);
          for (const [ticket, entry] of tickets)
            if (entry.integration.id === integration.id)
              return `${integration.local.callbackOrigin}${GOOGLE_SIGN_IN_PATH}?ticket=${ticket}`;
          if (tickets.size >= 1000) return undefined;
          const ticket = yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageError));
          tickets.set(ticket, { integration, expires: now + AUTH_LIFETIME_MS });
          return `${integration.local.callbackOrigin}${GOOGLE_SIGN_IN_PATH}?ticket=${ticket}`;
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
              operation: "start Google sign-in (link expired; list integrations for a new link)",
              reason: "not_found",
            });
          if (yield* hasCredentials(entry.integration.id)) return { connected: true };
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
        return success && (yield* hasCredentials(entry.integration.id));
      }),
  });
});

export const layer = Layer.effect(LocalIntegrations, make);
