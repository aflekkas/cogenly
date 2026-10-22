/**
 * What `cogenly setup` and `cogenly t3-import` drive, behind one shape: a
 * running Cogenly over its RPCs (see `liveServer.ts`), or the same services
 * in-process when no server owns the home. The CLI flow above it doesn't
 * know which.
 *
 * @module cli/setupBackend
 */
import {
  type AgentSessionImportResult,
  type AgentSessionProjectCandidate,
  type AgentSessionScanResult,
  CommandId,
  type ProviderInstanceMutation,
  ProjectId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
  T3ImportError,
  type T3ImportRunInput,
  type T3ImportScanInput,
  type T3ImportStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readProviderStatusCache } from "../provider/providerStatusCache.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { layerOffline } from "../t3Import/T3ImportOfflineLayer.ts";
import * as T3Import from "../t3Import/T3ImportService.ts";
import {
  liveWebSocketUrl,
  liveWebSocketUrlSource,
  makeLiveRpcClient,
  resolveCliServerRoute,
  SETUP_CLI_SCOPES,
} from "./liveServer.ts";

export class SetupBackendError extends Schema.TaggedError<SetupBackendError>()(
  "SetupBackendError",
  {
    operation: Schema.Literals([
      "read-providers",
      "read-settings",
      "update-settings",
      "import-status",
      "import-scan",
      "import-run",
      "import-cancel",
      "sessions-scan",
      "sessions-import",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Setup failed (${this.operation}).`;
  }
}

const isT3ImportError = Schema.is(T3ImportError);
const isSetupBackendError = Schema.is(SetupBackendError);

/**
 * The connection to the running server dropped (a socket error or a missed
 * ping, e.g. while the server was busy), as opposed to the server refusing
 * the call. Jobs run on the server, so a follower can subscribe again.
 */
export const isConnectionLoss = (error: unknown): boolean =>
  isSetupBackendError(error) &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  "_tag" in error.cause &&
  error.cause._tag === "RpcClientError";

type Operation = SetupBackendError["operation"];

/** Wrap a lower-level failure; an import refusal passes through with its own reason. */
const wrap =
  (operation: Operation) =>
  (cause: unknown): SetupBackendError | T3ImportError =>
    isT3ImportError(cause) ? cause : new SetupBackendError({ operation, cause });

const fail =
  (operation: Operation) =>
  (cause: unknown): SetupBackendError =>
    new SetupBackendError({ operation, cause });

export interface SetupBackend {
  readonly target:
    | { readonly _tag: "live"; readonly origin: string; readonly environmentLabel: string }
    | { readonly _tag: "offline"; readonly baseDir: string };
  /** Live: freshly probed. Offline: what the server last saw, from its status cache. */
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>, SetupBackendError>;
  readonly settings: Effect.Effect<ServerSettings, SetupBackendError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
    providerInstanceMutation?: ProviderInstanceMutation,
  ) => Effect.Effect<void, SetupBackendError>;
  /** The Settings → Import job API, unchanged. */
  readonly t3Import: {
    readonly status: Stream.Stream<T3ImportStatus, SetupBackendError>;
    readonly scan: (
      input: T3ImportScanInput,
    ) => Effect.Effect<void, SetupBackendError | T3ImportError>;
    readonly run: (
      input: T3ImportRunInput,
    ) => Effect.Effect<void, SetupBackendError | T3ImportError>;
    readonly cancel: Effect.Effect<void, SetupBackendError>;
  };
  /** The raw session import runs the orchestrator, so it needs the running server. */
  readonly sessions: Option.Option<{
    readonly scan: Effect.Effect<AgentSessionScanResult, SetupBackendError>;
    readonly importCandidate: (
      candidate: AgentSessionProjectCandidate,
    ) => Effect.Effect<AgentSessionImportResult, SetupBackendError>;
  }>;
}

const makeLive = Effect.fn("cli.setup.makeLiveBackend")(function* (input: {
  readonly origin: string;
  readonly url: Effect.Effect<string>;
}) {
  const client = yield* makeLiveRpcClient(input.url);
  const crypto = yield* Crypto.Crypto;
  const config = yield* client[WS_METHODS.serverGetConfig]({}).pipe(
    Effect.mapError(fail("read-settings")),
  );
  const uuid = crypto.randomUUIDv4().pipe(Effect.mapError(fail("sessions-import")));
  return {
    target: { _tag: "live", origin: input.origin, environmentLabel: config.environment.label },
    providers: client[WS_METHODS.serverRefreshProviders]({}).pipe(
      Effect.map((result) => result.providers),
      Effect.mapError(fail("read-providers")),
    ),
    settings: client[WS_METHODS.serverGetSettings]({}).pipe(Effect.mapError(fail("read-settings"))),
    updateSettings: (patch, providerInstanceMutation) =>
      client[WS_METHODS.serverUpdateSettings]({
        patch,
        ...(providerInstanceMutation === undefined ? {} : { providerInstanceMutation }),
      }).pipe(Effect.asVoid, Effect.mapError(fail("update-settings"))),
    t3Import: {
      status: client[WS_METHODS.t3ImportStatus]({}).pipe(Stream.mapError(fail("import-status"))),
      scan: (scanInput) =>
        client[WS_METHODS.t3ImportScan](scanInput).pipe(
          Effect.asVoid,
          Effect.mapError(wrap("import-scan")),
        ),
      run: (runInput) =>
        client[WS_METHODS.t3ImportRun](runInput).pipe(
          Effect.asVoid,
          Effect.mapError(wrap("import-run")),
        ),
      cancel: client[WS_METHODS.t3ImportCancel]({}).pipe(
        Effect.asVoid,
        Effect.mapError(fail("import-cancel")),
      ),
    },
    sessions: Option.some({
      scan: client[WS_METHODS.agentSessionsScan]({}).pipe(Effect.mapError(fail("sessions-scan"))),
      importCandidate: (candidate) =>
        Effect.gen(function* () {
          // Same steps as onboarding: a project at the folder, then its sessions.
          let projectId = candidate.projectId;
          if (projectId === undefined) {
            const created = yield* client[WS_METHODS.projectsMutate]({
              type: "project.create",
              commandId: CommandId.make(`cli-setup:project:create:${yield* uuid}`),
              projectId: ProjectId.make(yield* uuid),
              title: candidate.title,
              workspaceRoot: candidate.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            }).pipe(Effect.mapError(fail("sessions-import")));
            projectId = created.id;
          }
          return yield* client[WS_METHODS.agentSessionsImport]({
            projectId,
            expectedWorkspaceRoot: candidate.path,
          }).pipe(Effect.mapError(fail("sessions-import")));
        }),
    }),
  } satisfies SetupBackend;
});

const makeOffline = Effect.fn("cli.setup.makeOfflineBackend")(function* (
  config: ServerConfig.ServerConfig["Service"],
  options: T3Import.T3ImportServiceOptions,
) {
  const context = yield* Layer.build(
    layerOffline(options).pipe(
      Layer.provideMerge(ServerSettingsService.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    ),
  );
  const t3Import = Context.get(context, T3Import.T3ImportService);
  const settings = Context.get(context, ServerSettingsService.ServerSettingsService);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cachedProviders = Effect.gen(function* () {
    const names = yield* fileSystem
      .readDirectory(config.providerStatusCacheDir)
      .pipe(Effect.orElseSucceed(() => []));
    const providers: Array<ServerProvider> = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
      const cached = yield* readProviderStatusCache(path.join(config.providerStatusCacheDir, name));
      if (cached !== undefined) providers.push(cached);
    }
    return providers;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  return {
    target: { _tag: "offline", baseDir: config.baseDir },
    providers: cachedProviders,
    settings: settings.getSettings.pipe(Effect.mapError(fail("read-settings"))),
    updateSettings: (patch, providerInstanceMutation) =>
      (providerInstanceMutation === undefined
        ? settings.updateSettings(patch)
        : settings.updateProviderInstance(providerInstanceMutation, patch)
      ).pipe(Effect.asVoid, Effect.mapError(fail("update-settings"))),
    t3Import: {
      status: t3Import.status,
      scan: (input) => t3Import.scan(input).pipe(Effect.asVoid),
      run: (input) => t3Import.run(input).pipe(Effect.asVoid),
      cancel: t3Import.cancel.pipe(Effect.asVoid),
    },
    sessions: Option.none(),
  } satisfies SetupBackend;
});

/**
 * Open the backend for `config`'s home, for the life of the surrounding
 * scope: the running server when it answers, else the home directly, owned
 * by this process. Fails while a server holds the home but doesn't answer.
 */
export const openSetupBackend = Effect.fn("cli.setup.openBackend")(function* (
  config: ServerConfig.ServerConfig["Service"],
  options: T3Import.T3ImportServiceOptions & { readonly label: string },
) {
  const authContext = yield* Layer.build(
    EnvironmentAuth.layerRuntime.pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
    ),
  );
  const environmentAuth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
  const recorded = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  // Set by the probe below; a cast keeps TS from narrowing it to null.
  let liveUrl = null as { readonly token: string; readonly first: string } | null;
  const route = yield* resolveCliServerRoute({
    recordedOrigin: Option.map(recorded, (state) => state.origin),
    reachable: (origin) =>
      Effect.gen(function* () {
        const issued = yield* environmentAuth.issueSession({
          scopes: [...SETUP_CLI_SCOPES],
          label: options.label,
        });
        yield* Effect.addFinalizer(() =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
        );
        const url = yield* liveWebSocketUrl(origin, issued.token).pipe(
          Effect.provideContext(authContext),
          Effect.option,
        );
        if (Option.isNone(url)) {
          yield* Effect.logDebug("The recorded Cogenly server did not answer.", { origin });
          return false;
        }
        liveUrl = { token: issued.token, first: url.value };
        return true;
      }),
    acquireOwnership: ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
      Effect.andThen(clearPersistedServerRuntimeState(config.serverRuntimeStatePath)),
      Effect.provide(ProcessRunner.layer),
    ),
  });
  const { sourceDir, snapshotRoot } = options;
  const serviceOptions = {
    ...(sourceDir === undefined ? {} : { sourceDir }),
    ...(snapshotRoot === undefined ? {} : { snapshotRoot }),
  };
  return route._tag === "live" && liveUrl !== null
    ? yield* makeLive({
        origin: route.origin,
        url: liveWebSocketUrlSource({ origin: route.origin, ...liveUrl }).pipe(
          Effect.provideContext(authContext),
        ),
      })
    : yield* makeOffline(config, serviceOptions);
});
