import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";
import { applyModelEffortDefaults } from "@cogenly/shared/model";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
} from "./runtime.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import {
  isRpcClientError,
  request,
  runStream,
  subscribe,
  subscribeDynamicWithSession,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
} from "./serverConfigProjection.ts";

// Exported server state includes this type in its inferred public return type.
export type { ServerConfigProjection } from "./serverConfigProjection.ts";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";

export type ServerUpdateState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "failed";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      readonly message: string;
    };

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.serverUpdateServer>;
}

const IDLE_SERVER_UPDATE_STATE: ServerUpdateState = { status: "idle" };
const EMPTY_SERVER_UPDATE_STATE_ATOM = Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
  Atom.withLabel("environment-data:server:update-state:empty"),
);
/** Shared with the outdated-host update, which reports through the same state. */
export const serverUpdateStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
    Atom.withLabel(`environment-data:server:update-state:${environmentId}`),
  ),
);

export class ServerUpdateResumeTimeoutError extends Schema.TaggedError<ServerUpdateResumeTimeoutError>()(
  "ServerUpdateResumeTimeoutError",
  {
    environmentId: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The server did not resume on Cogenly ${this.targetVersion}.`;
  }
}

export class ServerUpdateProgressIncompleteError extends Schema.TaggedError<ServerUpdateProgressIncompleteError>()(
  "ServerUpdateProgressIncompleteError",
  {
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The Cogenly ${this.targetVersion} update ended before the server accepted the restart.`;
  }
}

export class ServerUpdateTerminalError extends Schema.TaggedError<ServerUpdateTerminalError>()(
  "ServerUpdateTerminalError",
  {
    targetVersion: Schema.String,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `The Cogenly ${this.targetVersion} update ${this.status}.`;
  }
}

// Covers the service launcher's 30-minute trial deadline (PREPARED_TIMEOUT_MS)
// and a final restart of the previous version when the trial rolls back.
const SERVER_UPDATE_RESUME_TIMEOUT = Duration.minutes(32);

export function matchesServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return result.updateId === undefined
    ? event.payload.environment.serverVersion === result.targetVersion
    : event.payload.updateOutcome?.id === result.updateId;
}

export function matchesServerUpdateResumeEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return (
    (result.method === "desktop-app" && result.desktopUpdateToken !== undefined) ||
    matchesServerUpdateReadyEvent(result, event)
  );
}

export function validateServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): Effect.Effect<void, ServerUpdateTerminalError> {
  if (result.updateId === undefined) return Effect.void;
  const outcome = event.payload.updateOutcome;
  if (
    outcome?.id === result.updateId &&
    outcome.status === "committed" &&
    outcome.targetVersion === result.targetVersion &&
    event.payload.environment.serverVersion === result.targetVersion
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ServerUpdateTerminalError({
      targetVersion: result.targetVersion,
      status: outcome?.status ?? "failed",
      reason:
        outcome?.reason ??
        "The service launcher resumed without committing the requested server version.",
    }),
  );
}

/**
 * Keeps reconnect attempts ~1s apart for the whole update restart.
 *
 * A restart takes the server down for ~15 seconds, but the supervisor's normal
 * backoff assumes an unexpected failure and doubles its delay after each failed
 * attempt, so a 15-second restart can be observed as a ~30-second "Resuming".
 * Nudging on every backoff entry (not just the first)
 * holds the retry cadence flat until the server answers again. The sleep before
 * each nudge is the pacer: a connection that fails instantly re-enters backoff
 * immediately and would otherwise spin a tight retry loop.
 *
 * A newly restarted server can also reject the first environment credential.
 * Authentication blocks need the same paced retry during this known restart;
 * permission and configuration failures remain blocked.
 *
 * Callers fork this as a child of the update command so it is interrupted as
 * soon as the update settles, whether it succeeds, fails, or times out.
 */
export function nudgeReconnectDuringUpdateRestart(input: {
  readonly stateChanges: Stream.Stream<
    {
      readonly phase: string;
      readonly lastFailure?: { readonly reason: string } | null;
    },
    unknown
  >;
  readonly retryNow: Effect.Effect<void>;
  readonly interval?: Duration.Duration;
}): Effect.Effect<void> {
  return input.stateChanges.pipe(
    Stream.filter(
      (state) =>
        state.phase === "backoff" ||
        (state.phase === "blocked" && state.lastFailure?.reason === "authentication"),
    ),
    Stream.runForEach(() =>
      Effect.sleep(input.interval ?? Duration.seconds(1)).pipe(Effect.andThen(input.retryNow)),
    ),
    Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
    Effect.ignore,
  );
}

export function waitForNextEnvironmentReconnect<E>(
  stateChanges: Stream.Stream<{ readonly phase: string }, E>,
): Effect.Effect<void, E> {
  return stateChanges.pipe(
    Stream.dropWhile((state) => state.phase === "connected"),
    Stream.filter((state) => state.phase === "connected"),
    Stream.runHead,
    Effect.asVoid,
  );
}

export const runDesktopCommitWithReconnectObserver = Effect.fn(
  "runDesktopCommitWithReconnectObserver",
)(function* <EState, ECommit>(
  stateChanges: Stream.Stream<{ readonly phase: string }, EState>,
  commit: Effect.Effect<void, ECommit>,
) {
  const armed = yield* Deferred.make<void>();
  const reconnected = yield* Deferred.make<void>();
  const observer = yield* stateChanges.pipe(
    Stream.tap(() => Deferred.succeed(armed, undefined)),
    waitForNextEnvironmentReconnect,
    Effect.andThen(Deferred.succeed(reconnected, undefined)),
    Effect.forkChild,
  );
  yield* Deferred.await(armed);
  const commitExit = yield* commit.pipe(Effect.exit);
  if (Exit.isSuccess(commitExit)) {
    yield* Fiber.interrupt(observer);
    return;
  }
  if (!isLegacyUpdateHandoffLoss(commitExit.cause)) {
    yield* Fiber.interrupt(observer);
    return yield* Effect.failCause(commitExit.cause);
  }
  yield* Deferred.await(reconnected).pipe(Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT));
  return yield* Effect.failCause(commitExit.cause);
});

export const waitForDesktopUpdateTarget = Effect.fn("waitForDesktopUpdateTarget")(function* <
  EReady,
  ECommit,
>(
  targetVersion: string,
  nextReady: Effect.Effect<ServerLifecycleStreamReadyEvent, EReady>,
  retryCommit: Effect.Effect<void, ECommit>,
  maxCommitAttempts = 3,
): Effect.fn.Return<ServerLifecycleStreamReadyEvent, EReady | ECommit | ServerUpdateTerminalError> {
  for (let attempt = 1; attempt <= maxCommitAttempts; attempt += 1) {
    const ready = yield* nextReady;
    if (ready.payload.environment.serverVersion === targetVersion) return ready;
    if (attempt === maxCommitAttempts) break;
    const retryExit = yield* retryCommit.pipe(Effect.exit);
    if (Exit.isSuccess(retryExit)) break;
    if (!isLegacyUpdateHandoffLoss(retryExit.cause)) {
      return yield* Effect.failCause(retryExit.cause);
    }
  }
  return yield* new ServerUpdateTerminalError({
    targetVersion,
    status: "failed",
    reason: "The desktop app resumed without installing the prepared update.",
  });
});

/**
 * "resuming" means the server has its update and restarts without this
 * client. A desktop app update is not there yet when its prepare step
 * completes: the client still has to commit it, so it stays "installing".
 */
export function serverUpdateStateForProgressEvent(
  fromVersion: string,
  targetVersion: string,
  event: ServerSelfUpdateProgressEvent,
): Extract<ServerUpdateState, { status: "running" }> {
  return {
    status: "running",
    stage:
      event.type !== "complete"
        ? event.stage
        : event.result.method === "desktop-app" && event.result.desktopUpdateToken !== undefined
          ? "installing"
          : "resuming",
    fromVersion,
    targetVersion,
  };
}

export function serverUpdateStateForServerVersion(
  state: ServerUpdateState,
  serverVersion: string | null,
): ServerUpdateState {
  return state.status === "idle" ||
    state.status === "running" ||
    serverVersion === null ||
    state.fromVersion === serverVersion
    ? state
    : IDLE_SERVER_UPDATE_STATE;
}

export function serverUpdateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function isRpcSocketError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export function isLegacyUpdateHandoffLoss(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) {
    return true;
  }
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => Cause.isFailReason(reason) && isRpcSocketError(reason.error))
  );
}

export function resolveServerUpdateProgressResult<E>(
  targetVersion: string,
  terminal: Option.Option<ServerSelfUpdateResult>,
  streamExit: Exit.Exit<void, E>,
): Effect.Effect<ServerSelfUpdateResult, E | ServerUpdateProgressIncompleteError> {
  if (
    Option.isSome(terminal) &&
    (Exit.isSuccess(streamExit) || isLegacyUpdateHandoffLoss(streamExit.cause))
  ) {
    return Effect.succeed(terminal.value);
  }
  if (Exit.isFailure(streamExit)) {
    return Effect.failCause(streamExit.cause);
  }
  return Effect.fail(new ServerUpdateProgressIncompleteError({ targetVersion }));
}

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

export interface ServerConfigSubscriptionOptions {
  readonly usageLimitsCommand?: boolean;
}

export const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* (subscription: ServerConfigSubscriptionOptions) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const cache = yield* Persistence.EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache.loadServerConfig(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(Option.none<ServerConfig>()),
        ),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      // Stripped on load as well as on save: a cache written by an earlier
      // build can still carry published themes.
      Option.map(cachedConfig, (cached) => ({
        config: cached,
        latestEvent: cachedConfigSnapshotEvent(cached),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      return yield* cache.saveServerConfig(environmentId, config).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    yield* runCachePersistence(persistence, persistPending).pipe(Effect.forkScoped);

    yield* subscribe(WS_METHODS.subscribeServerConfig, {
      ...(subscription.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
    }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const next = applyServerConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) {
            return;
          }
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverConfigStateChanges(
  environmentId: EnvironmentId,
  subscription: ServerConfigSubscriptionOptions,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState(subscription).pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: (value) => Result.succeed(value),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function applyServerWelcomeEvent(
  current: EnvironmentServerWelcomeState,
  session: RpcSession,
  event: {
    readonly type: "welcome" | "ready" | "legacyThreadMigration";
    readonly payload: unknown;
  },
): EnvironmentServerWelcomeState {
  return event.type === "welcome" && current.currentSession === session
    ? {
        ...current,
        welcomeSession: session,
        welcome: event.payload as ServerLifecycleWelcomePayload,
      }
    : current;
}

export interface EnvironmentServerWelcomeState {
  readonly currentSession: RpcSession | null;
  readonly welcomeSession: RpcSession | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

export function resolveServerWelcomeState(
  state: EnvironmentServerWelcomeState,
): ServerLifecycleWelcomePayload | null {
  return state.currentSession === state.welcomeSession ? state.welcome : null;
}

export const makeEnvironmentServerWelcomeState = Effect.fn("EnvironmentServerWelcomeState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const initialSession = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
    const state = yield* SubscriptionRef.make<EnvironmentServerWelcomeState>({
      currentSession: initialSession,
      welcomeSession: null,
      welcome: null,
    });

    const updateWithCurrentSession = Effect.fn(
      "EnvironmentServerWelcomeState.updateWithCurrentSession",
    )(function* (
      update: (
        current: EnvironmentServerWelcomeState,
        currentSession: RpcSession | null,
      ) => EnvironmentServerWelcomeState,
    ) {
      return yield* SubscriptionRef.modifyEffect(state, (current) =>
        SubscriptionRef.get(supervisor.session).pipe(
          Effect.map(
            (latestSession) =>
              [undefined, update(current, Option.getOrNull(latestSession))] as const,
          ),
        ),
      );
    });

    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.runForEach(() =>
        updateWithCurrentSession((current, currentSession) => ({
          ...current,
          currentSession,
        })),
      ),
      Effect.forkScoped,
    );

    yield* subscribeDynamicWithSession(
      WS_METHODS.subscribeServerLifecycle,
      Effect.fn("EnvironmentServerWelcomeState.makeSubscribeInput")(function* (session) {
        yield* updateWithCurrentSession((current, currentSession) =>
          currentSession === session
            ? {
                ...current,
                currentSession,
                welcomeSession: session,
                welcome: null,
              }
            : { ...current, currentSession },
        );
        return {};
      }),
    ).pipe(
      Stream.runForEach(([session, event]) =>
        updateWithCurrentSession((current, currentSession) =>
          applyServerWelcomeEvent(
            {
              ...current,
              currentSession,
            },
            session,
            event,
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverWelcomeStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerWelcomeState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(Stream.map(resolveServerWelcomeState)),
        ),
      ),
    ),
  );
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return withModelEffortDefaults(projection.config);
  }
  const config = initialConfig ?? projection?.config ?? null;
  return config === null ? null : withModelEffortDefaults(config);
}

/**
 * Providers whose models start at the user's configured reasoning effort
 * (Settings → Providers), so every picker and new draft reads one default.
 */
function withModelEffortDefaults(config: ServerConfig): ServerConfig {
  const defaults = config.settings.modelEffortDefaults;
  if (!defaults || Object.keys(defaults).length === 0) return config;
  let changed = false;
  const providers = config.providers.map((provider) => {
    const models = applyModelEffortDefaults(provider.models, defaults[provider.instanceId]);
    if (models === provider.models) return provider;
    changed = true;
    return { ...provider, models };
  });
  return changed ? { ...config, providers } : config;
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
    /**
     * Whether this surface renders themes the environment publishes. Mobile
     * keeps its own appearance settings, so it neither asks for the stream nor
     * receives the payload.
     */
    /** Whether this surface renders quota from configured usage-limit sources. */
    readonly usageLimitsCommand?: boolean;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  // Updates stay serial end-to-end, but only their handoff phase occupies the config lane.
  const updateScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        serverConfigStateChanges(environmentId, {
          ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
        }),
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const updateStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      serverUpdateStateForServerVersion(
        get(serverUpdateStateAtom(environmentId)),
        get(configValueAtom(environmentId))?.environment.serverVersion ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:server:update-state-value:${environmentId}`)),
  );
  const updateStateAtom = (environmentId: EnvironmentId | null) =>
    environmentId === null ? EMPTY_SERVER_UPDATE_STATE_ATOM : updateStateValueAtom(environmentId);
  const updateServer = createRuntimeCommand<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E,
    ServerUpdateTarget,
    ServerSelfUpdateResult,
    unknown
  >(runtime, {
    label: "environment-data:server:update-server",
    scheduler: updateScheduler,
    concurrency: configConcurrency,
    execute: (target, atomRegistry) => {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      let targetVersion = target.input.targetVersion;
      let fromVersion =
        atomRegistry.get(configValueAtom(target.environmentId))?.environment.serverVersion ??
        targetVersion;
      let currentStage: ServerUpdateStage = "downloading";
      let desktopCommitLostTransport = false;
      atomRegistry.set(stateAtom, {
        status: "running",
        stage: currentStage,
        fromVersion,
        targetVersion,
      });

      return Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const desktopCommitStarting = yield* Deferred.make<void>();
        const desktopReconnectObserverArmed = yield* Deferred.make<void>();
        const desktopReconnected = yield* Deferred.make<void>();
        yield* Deferred.await(desktopCommitStarting).pipe(
          Effect.andThen(
            environmentRegistry.stateChanges(target.environmentId).pipe(
              Stream.tap(() => Deferred.succeed(desktopReconnectObserverArmed, undefined)),
              Stream.dropWhile((state) => state.phase === "connected"),
              Stream.filter((state) => state.phase === "connected"),
              Stream.runHead,
            ),
          ),
          Effect.andThen(Deferred.succeed(desktopReconnected, undefined)),
          Effect.forkChild,
        );
        const result = yield* scheduleAtomCommandEffect(
          atomRegistry,
          configScheduler,
          configConcurrency,
          target,
          Effect.gen(function* () {
            const currentConfig = atomRegistry.get(configValueAtom(target.environmentId));
            fromVersion = currentConfig?.environment.serverVersion ?? targetVersion;
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });

            const supportsProgress =
              currentConfig?.environment.capabilities.serverSelfUpdateProgress === true;
            const updateResult: ServerSelfUpdateResult = supportsProgress
              ? yield* Effect.gen(function* () {
                  const terminal = yield* Ref.make<Option.Option<ServerSelfUpdateResult>>(
                    Option.none(),
                  );
                  const streamExit = yield* environmentRegistry
                    .runStream(
                      target.environmentId,
                      runStream(WS_METHODS.serverUpdateServerWithProgress, target.input),
                    )
                    .pipe(
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          const state = serverUpdateStateForProgressEvent(
                            fromVersion,
                            targetVersion,
                            event,
                          );
                          currentStage = state.stage;
                          atomRegistry.set(stateAtom, state);
                        }).pipe(
                          Effect.andThen(
                            event.type === "complete"
                              ? Ref.set(terminal, Option.some(event.result))
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.exit,
                    );
                  return yield* resolveServerUpdateProgressResult(
                    targetVersion,
                    yield* Ref.get(terminal),
                    streamExit,
                  );
                })
              : yield* Effect.gen(function* () {
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  const exit = yield* environmentRegistry
                    .run(target.environmentId, request(WS_METHODS.serverUpdateServer, target.input))
                    .pipe(Effect.exit);
                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }
                  if (
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn") &&
                    isLegacyUpdateHandoffLoss(exit.cause)
                  ) {
                    // Older servers can tear down the transport before their
                    // unary acknowledgement arrives. Treat only that transport
                    // loss as a handoff, then prove it by waiting for target ready.
                    return { targetVersion, method: selfUpdateMethod };
                  }
                  return yield* Effect.failCause(exit.cause);
                });

            if (
              updateResult.method === "desktop-app" &&
              updateResult.desktopUpdateToken !== undefined
            ) {
              yield* Deferred.succeed(desktopCommitStarting, undefined);
              yield* Deferred.await(desktopReconnectObserverArmed);
              const commitExit = yield* environmentRegistry
                .run(
                  target.environmentId,
                  request(WS_METHODS.serverCommitDesktopUpdate, {
                    requestId: updateResult.desktopUpdateToken,
                  }),
                )
                .pipe(Effect.exit);
              if (Exit.isFailure(commitExit) && !isLegacyUpdateHandoffLoss(commitExit.cause)) {
                return yield* Effect.failCause(commitExit.cause);
              }
              desktopCommitLostTransport = Exit.isFailure(commitExit);
            }

            targetVersion = updateResult.targetVersion;

            currentStage = "resuming";
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });
            return updateResult;
          }),
        );

        // The update restart is intentional and the server stays unreachable
        // for the whole restart, so hold the retry cadence flat instead of
        // letting the supervisor climb its backoff ladder.
        yield* nudgeReconnectDuringUpdateRestart({
          stateChanges: environmentRegistry.stateChanges(target.environmentId),
          retryNow: environmentRegistry.retryNow(target.environmentId),
        }).pipe(Effect.forkChild);

        if (result.method === "desktop-app" && desktopCommitLostTransport) {
          yield* Deferred.await(desktopReconnected).pipe(
            Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT),
          );
        }

        const waitForReady = environmentRegistry
          .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {}))
          .pipe(
            Stream.filter(
              (event): event is ServerLifecycleStreamReadyEvent =>
                event.type === "ready" && matchesServerUpdateResumeEvent(result, event),
            ),
            Stream.runHead,
            Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
            Effect.map(Option.flatten),
          );
        const nextReady = waitForReady.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new ServerUpdateResumeTimeoutError({
                  environmentId: target.environmentId,
                  targetVersion,
                }),
              onSome: Effect.succeed,
            }),
          ),
        );
        const desktopUpdateToken = result.desktopUpdateToken;
        const resumed =
          result.method === "desktop-app" && desktopUpdateToken !== undefined
            ? yield* waitForDesktopUpdateTarget(
                result.targetVersion,
                nextReady,
                runDesktopCommitWithReconnectObserver(
                  environmentRegistry.stateChanges(target.environmentId),
                  environmentRegistry
                    .run(
                      target.environmentId,
                      request(WS_METHODS.serverCommitDesktopUpdate, {
                        requestId: desktopUpdateToken,
                      }),
                    )
                    .pipe(Effect.asVoid),
                ),
              )
            : yield* nextReady;
        yield* validateServerUpdateReadyEvent(result, resumed);

        atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              return;
            }
            if (Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
              return;
            }
            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    },
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const usageScanSettingsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const settings = get(settingsValueAtom(environmentId));
      const aliases = settings?.usageModelAliases ?? {};
      // Only changed mappings should trigger another transcript scan. Settings
      // snapshots can recreate the same mapping in a different property order.
      return JSON.stringify(
        Object.keys(aliases)
          .sort()
          .map((model) => [model, aliases[model]]),
      );
    }).pipe(Atom.withLabel(`environment-data:server:usage-scan-settings:${environmentId}`)),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );
  const welcomeStateFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverWelcomeStateChanges(environmentId), { initialValue: null })
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:welcome-state:${environmentId}`),
      ),
  );
  const welcomeFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(welcomeStateFamily(environmentId));
      if (result._tag !== "Success") return result;
      return result.value === null
        ? AsyncResult.initial<ServerLifecycleWelcomePayload, never>(result.waiting)
        : AsyncResult.success(result.value, result);
    }).pipe(Atom.withLabel(`environment-data:server:welcome:${environmentId}`)),
  );
  const welcome = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerLifecycle>;
  }) => welcomeFamily(target.environmentId);
  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
    scheduler: configScheduler,
    concurrency: configConcurrency,
  });

  return {
    configValueAtom,
    storageStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:storage-status",
      tag: WS_METHODS.serverGetStorageStatus,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    runStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:run-storage-cleanup",
      tag: WS_METHODS.serverRunStorageCleanup,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    databaseStorage: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:database-storage",
      tag: WS_METHODS.serverGetDatabaseStorage,
      idleTtlMs: 0,
    }),
    storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:storage-cleanup-report",
      tag: WS_METHODS.serverGetStorageCleanupReport,
      idleTtlMs: 0,
    }),
    updateStateAtom,
    settingsValueAtom,
    providersValueAtom,
    providerAuthState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:auth-state",
      tag: WS_METHODS.providerAuthSubscribe,
      idleTtlMs: 0,
    }),
    startProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-start",
      tag: WS_METHODS.providerAuthStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    respondProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-respond",
      tag: WS_METHODS.providerAuthRespond,
    }),
    completeProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-complete",
      tag: WS_METHODS.providerAuthComplete,
    }),
    chatGptReconnectProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:reconnect-profile",
      tag: WS_METHODS.chatGptReconnectProfile,
    }),
    chatGptImportProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chatgpt:import-profile",
      tag: WS_METHODS.chatGptImportProfile,
    }),
    chatGptHandoffState: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:chatgpt:handoff",
      sensitiveInput: true,
      // OAuth must not be replayed when the connection recovers.
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.chatGptHandoffSubscribe>) =>
        runStream(WS_METHODS.chatGptHandoffSubscribe, input),
      idleTtlMs: 0,
    }),
    codexAuthCallbackState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:codex:auth-callback",
      tag: WS_METHODS.codexAuthCallbackSubscribe,
      idleTtlMs: 0,
    }),
    cancelProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-cancel",
      tag: WS_METHODS.providerAuthCancel,
    }),
    logoutProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-logout",
      tag: WS_METHODS.providerAuthLogout,
    }),
    providerInstallState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:install-state",
      tag: WS_METHODS.providerInstallSubscribe,
      idleTtlMs: 0,
    }),
    startProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-start",
      tag: WS_METHODS.providerInstallStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    cancelProviderInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-cancel",
      tag: WS_METHODS.providerInstallCancel,
    }),
    removeProviderInstallation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:install-remove",
      tag: WS_METHODS.providerInstallRemove,
    }),
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    hostResources: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:server:host-resources",
      idleTtlMs: 0,
      staleTimeMs: 5_000,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.serverGetHostResources>) =>
        request(WS_METHODS.serverGetHostResources, input).pipe(Effect.timeout("5 seconds")),
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    scheduledTaskWebhookDeliveries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-deliveries",
      tag: WS_METHODS.scheduledTasksListWebhookDeliveries,
    }),
    scheduledTaskWebhookDelivery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:scheduled-task:webhook-delivery",
      tag: WS_METHODS.scheduledTasksGetWebhookDelivery,
    }),
    searchQuery: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "environment-data:search:query",
      tag: WS_METHODS.searchQuery,
    }),
    projectLabels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projectLabels:projectLabels",
      tag: WS_METHODS.projectLabelsList,
    }),
    projectLabelsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projectLabels:projectLabelsLive",
      tag: WS_METHODS.projectLabelsSubscribe,
    }),
    threadProjectLabels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projectLabels:threadProjectLabels",
      tag: WS_METHODS.projectLabelsGetThreadLabels,
    }),
    threadProjectLabelsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projectLabels:threadProjectLabelsLive",
      tag: WS_METHODS.projectLabelsSubscribeThreadLabels,
    }),
    /** Legacy membership feed. New list views use each shell thread's projectFolderId. */
    confirmedThreadProjectLabelsLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projectLabels:confirmedThreadProjectLabelsLive",
      tag: WS_METHODS.projectLabelsSubscribeConfirmedThreadLabels,
    }),
    createProjectLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:createProjectLabel",
      tag: WS_METHODS.projectLabelsCreate,
    }),
    updateProjectLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:updateProjectLabel",
      tag: WS_METHODS.projectLabelsUpdate,
    }),
    mergeProjectLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:mergeProjectLabels",
      tag: WS_METHODS.projectLabelsMerge,
    }),
    dismissProjectLabelDuplicate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:dismissProjectLabelDuplicate",
      tag: WS_METHODS.projectLabelsDismissDuplicate,
    }),
    undismissProjectLabelDuplicate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:undismissProjectLabelDuplicate",
      tag: WS_METHODS.projectLabelsUndismissDuplicate,
    }),
    deleteProjectLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:deleteProjectLabel",
      tag: WS_METHODS.projectLabelsDelete,
    }),
    archiveProjectLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:archiveProjectLabel",
      tag: WS_METHODS.projectLabelsArchive,
    }),
    unarchiveProjectLabel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:unarchiveProjectLabel",
      tag: WS_METHODS.projectLabelsUnarchive,
    }),
    linkProjectLabelRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:linkProjectLabelRepository",
      tag: WS_METHODS.projectLabelsLinkRepository,
    }),
    unlinkProjectLabelRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:unlinkProjectLabelRepository",
      tag: WS_METHODS.projectLabelsUnlinkRepository,
    }),
    linkProjectLabelSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:linkProjectLabelSource",
      tag: WS_METHODS.projectLabelsLinkSource,
    }),
    unlinkProjectLabelSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:unlinkProjectLabelSource",
      tag: WS_METHODS.projectLabelsUnlinkSource,
    }),
    /** A project's files on disk, live: the project directory minus git work trees. */
    projectLabelResourcesLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projectLabels:resourcesLive",
      tag: WS_METHODS.projectLabelsSubscribeResources,
    }),
    addProjectLabelResource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:addProjectLabelResource",
      tag: WS_METHODS.projectLabelsAddResource,
    }),
    removeProjectLabelResource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:removeProjectLabelResource",
      tag: WS_METHODS.projectLabelsRemoveResource,
    }),
    /** The project's own chat: created on first call, the same thread afterwards. */
    ensureProjectChat: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:ensureProjectChat",
      tag: WS_METHODS.projectLabelsEnsureProjectChat,
    }),
    /** GitHub repositories under a project's linked owners; empty query lists recent pushes. */
    projectLabelOwnerRepositories: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projectLabels:ownerRepositories",
      tag: WS_METHODS.projectLabelsSearchOwnerRepositories,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    /** Clone a repository into a project; progress arrives on the project-clone stream. */
    cloneProjectLabelRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:cloneProjectLabelRepository",
      tag: WS_METHODS.projectLabelsCloneRepository,
    }),
    /** Clone a repository the project links onto this machine; returns once the clone runs. */
    checkoutProjectLabelRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:checkoutProjectLabelRepository",
      tag: WS_METHODS.projectLabelsCheckoutRepository,
    }),
    /** Delete this machine's checkout of a linked repository; the link stays. */
    removeProjectLabelCheckout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:removeProjectLabelCheckout",
      tag: WS_METHODS.projectLabelsRemoveCheckout,
    }),
    /** Move a linked repository's checkout into `<project>/repos/<directoryName>`. */
    adoptProjectLabelRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:adoptProjectLabelRepository",
      tag: WS_METHODS.projectLabelsAdoptRepository,
    }),
    /** Project folders no project claims; refresh after adopting or removing one. */
    projectOrphanFolders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projectLabels:orphanFolders",
      tag: WS_METHODS.projectLabelsListOrphanFolders,
    }),
    /** Make an orphan folder a project of the same name, keeping its contents. */
    adoptProjectOrphanFolder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:adoptProjectOrphanFolder",
      tag: WS_METHODS.projectLabelsAdoptOrphanFolder,
    }),
    /** Delete an orphan folder that holds only an empty skeleton. */
    removeProjectOrphanFolder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:removeProjectOrphanFolder",
      tag: WS_METHODS.projectLabelsRemoveOrphanFolder,
    }),
    moveThreadProjectFolder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:moveThreadProjectFolder",
      tag: WS_METHODS.projectLabelsMoveThread,
    }),
    /** Hand a project's repositories, threads and agents to another paired machine. */
    moveProjectToMachine: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:moveProjectToMachine",
      tag: WS_METHODS.projectLabelsMoveToMachine,
    }),
    /** The machines this environment is paired with, live: a fresh list after every change. */
    machineProviders: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "environment-data:machines:providers",
      tag: WS_METHODS.machinesCatalog,
    }),
    machinesLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:machines:live",
      tag: WS_METHODS.machinesSubscribe,
    }),
    /** Copy the conversation to a paired machine in the same repository. */
    forkThreadToMachine: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:forkThreadToMachine",
      tag: WS_METHODS.machinesForkThread,
    }),
    /** Hand threads to another paired machine; answers once it runs them, with skips. */
    moveThreadsToMachine: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:moveThreadsToMachine",
      tag: WS_METHODS.machinesMoveThreads,
    }),
    /** Move a chat with turns into a project by forking it; returns the new chat. */
    forkThreadToProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:forkThreadToProject",
      tag: WS_METHODS.projectLabelsForkThreadToProject,
    }),
    setThreadProjectLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projectLabels:setThreadProjectLabels",
      tag: WS_METHODS.projectLabelsSetThreadLabels,
    }),
    /** Live scheduled-task list: snapshot on subscribe, fresh list after every server-side change. */
    scheduledTasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:scheduled-tasks:live",
      tag: WS_METHODS.scheduledTasksSubscribe,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    // Slow sources answer from cache first: that summary stays on screen, with
    // the query waiting, until one `awaitRefresh` request replaces it.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => usageScanSettingsAtom(environmentId),
      execute: (input, emit) =>
        request(WS_METHODS.serverGetUsageSummary, input).pipe(
          Effect.flatMap((summary) =>
            summary.sources.some((source) => source.refreshing === true)
              ? emit(summary).pipe(
                  Effect.andThen(
                    request(WS_METHODS.serverGetUsageSummary, { ...input, awaitRefresh: true }),
                  ),
                  // The cached summary is still the best data, and a failure
                  // would read as the environment not reporting usage at all.
                  Effect.catch((error) =>
                    Effect.logWarning("Could not refresh slow usage sources.").pipe(
                      Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
                      Effect.as(summary),
                    ),
                  ),
                )
              : Effect.succeed(summary),
          ),
        ),
    }),
    // The new-chat greeting for the client's local day and bucket. While the
    // server writes one, the first answer (`pending`) shows the built-in line
    // and a second request waits for the written greeting.
    chatGreeting: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:chat-greeting",
      tag: WS_METHODS.serverGetChatGreeting,
      staleTimeMs: 10 * 60_000,
      execute: (input, emit) =>
        request(WS_METHODS.serverGetChatGreeting, input).pipe(
          Effect.flatMap((greeting) =>
            greeting.pending
              ? emit(greeting).pipe(
                  Effect.andThen(
                    request(WS_METHODS.serverGetChatGreeting, { ...input, awaitGeneration: true }),
                  ),
                )
              : Effect.succeed(greeting),
          ),
        ),
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    configProjection,
    welcome,
    legacyThreadMigration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:legacy-thread-migration",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "legacyThreadMigration"
              ? Result.succeed(event.payload)
              : Result.failVoid,
          ),
        ),
    }),
    consumeResetCredit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:consume-reset-credit",
      tag: WS_METHODS.providerConsumeResetCredit,
      concurrency: {
        mode: "singleFlight",
        // Both ids are free-form strings; a delimiter could collide.
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.instanceId ?? null,
            input.cwd ?? null,
            input.fresh ?? false,
            input.refreshModels ?? false,
          ]),
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateServer,
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings,
    // Provider-instance mutations share the settings command and its
    // environment-serial scheduler. The named boundary keeps clients on the
    // atomic map-entry payload instead of rebuilding a stale whole map.
    mutateProviderInstance: updateSettings,
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    startWork: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:work:start",
      tag: WS_METHODS.workStart,
    }),
    upsertScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:upsert",
      tag: WS_METHODS.scheduledTasksUpsert,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setScheduledTaskEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:set-enabled",
      tag: WS_METHODS.scheduledTasksSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    deleteScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:delete",
      tag: WS_METHODS.scheduledTasksDelete,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Deliberately not on the config lane: run-now blocks until the run is
    // dispatched, and a slow run must not stall settings/keybinding/provider
    // mutations (or other scheduled-task edits) queued behind it.
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
    rotateScheduledTaskWebhookToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:rotate-webhook-token",
      tag: WS_METHODS.scheduledTasksRotateWebhookToken,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Off the config lane: answering a card must not queue behind settings
    // edits. One answer per card at a time.
    answerSecretRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-request",
      tag: WS_METHODS.secretsAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    answerLoginRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-login-request",
      tag: WS_METHODS.secretsAnswerLoginRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    refreshUsageRates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-usage-rates",
      tag: WS_METHODS.serverRefreshUsageRates,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    checkOtlpEndpoint: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:check-otlp-endpoint",
      tag: WS_METHODS.serverCheckOtlpEndpoint,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
