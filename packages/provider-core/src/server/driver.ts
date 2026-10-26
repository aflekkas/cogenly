/**
 * ProviderDriver / ProviderInstance: driver SPI as plain values.
 *
 * `ProviderDriver` is a record, not a Context.Service. The thing it produces
 * (`ProviderInstance`) is also a record of captured closures
 * (`snapshot`, `orchestrationAdapter`, `textGeneration`), an id, and a driver kind. There
 * are intentionally no per-driver Context tags because tags are
 * singleton-per-runtime and we need many instances of the same driver.
 *
 * The only Effect service involved is `ProviderInstanceRegistry`, which
 * owns the live `Map<InstanceId, ProviderInstance>` and is itself a
 * singleton.
 *
 * Driver factories are functions of `(typed config, env)` where:
 *   - `typed config` is decoded once by the registry via `configSchema`,
 *     so drivers never deal with raw `unknown`.
 *   - `env` flows through Effect's R channel. Each driver declares the
 *     subset of infrastructure services it needs (FileSystem,
 *     ChildProcessSpawner, …) on its `create` return type; the registry
 *     layer's R is the union of those, and the runtime layer satisfies it.
 *
 * @module provider-core/server/driver
 */
import type {
  ProviderConsumeResetCreditOutcome,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
  UsageProviderKind,
} from "@cogenly/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

/**
 * Static metadata advertised by a driver. Used for default presentation
 * and (later) settings UI. Doesn't need to be Effect-typed because nothing
 * about it is dynamic; drivers are registered at startup.
 */
export interface ProviderDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Codex"). */
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket); the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
  /**
   * Whether the server runs an instance at `defaultInstanceIdForDriver(kind)`
   * even when settings have no entry for it. Defaults to `true`; drivers that
   * need configuration before they can run opt out.
   */
  readonly hasDefaultInstance?: boolean;
  /**
   * Default chat model slug, used when the snapshot lists no models (a fresh
   * install whose probe has not answered yet). Mirrors the client
   * definition's `defaultModel`; a test keeps the two in sync.
   */
  readonly defaultModel?: string;
  /**
   * Cheap model for text generation (titles, commit messages, PR text).
   * Mirrors the client definition's `defaultTextGenerationModel`.
   */
  readonly defaultTextGenerationModel?: string;
  /**
   * Usage-bucket slug this driver's history reads as. Usually the driver
   * kind itself; `claudeAgent` reads as `claude` for historical buckets.
   * Omitted when the driver keeps no usage history.
   */
  readonly usageKind?: UsageProviderKind;
  /**
   * Order in the text-generation fallback chain; lower sorts first.
   * Omitted drivers never backstop text generation.
   */
  readonly textGenerationFallbackPriority?: number;
  /**
   * False hides the driver's instances from interactive pickers. Defaults
   * to `true`; drivers omit it unless they must stay out of the picker.
   */
  readonly pickerVisible?: boolean;
  /**
   * Normalize a probed version before compatibility checks, after the
   * generic leading-`v` strip. Muse uses this to drop its `-R…` release
   * revision; other drivers omit it and compare the bare semver.
   */
  readonly normalizeVersion?: (version: string) => string;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending">;

/**
 * One materialized provider instance. Held by the registry, looked up by
 * `instanceId`, torn down by closing the scope it was created in.
 *
 * The three "shape" fields are captured closures owned by this instance:
 * stopping one instance cannot affect another, and starting a second
 * instance of the same driver does not reach into the first instance's
 * state.
 */
export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  /** Invalidate T3-owned discovery caches before an explicit provider refresh. */
  readonly invalidateCaches?: Effect.Effect<void>;
  /**
   * Redeem one banked rate-limit reset credit on the signed-in account, then
   * re-probe so the snapshot reflects the cleared windows. Account-level,
   * not thread-level, which is why it lives here rather than on the adapter.
   */
  readonly consumeResetCredit?: () => Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError
  >;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

/**
 * Inputs the registry passes to a driver's `create` function.
 *
 * `config` is the typed payload, already decoded by the registry through
 * `driver.configSchema`. Drivers never decode their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/**
 * Driver SPI, registered as a plain value, not a Layer.
 *
 * `Config` is whatever the driver decoded from
 * `ProviderInstanceConfig.config`. `R` is the union of infrastructure
 * services the driver depends on; the registry layer aggregates `R` across
 * all registered drivers and the runtime supplies them.
 *
 * `create` is responsible for *all* per-instance state (process handles,
 * pubsub topics, refs, file watchers) and must release them when its
 * scope closes. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Decoder for the opaque `ProviderInstanceConfig.config` envelope. The
   * registry runs this exactly once per (re)load of an instance; a decode
   * failure is surfaced as `ProviderDriverError` and downgraded to an
   * unavailable shadow snapshot.
   *
   * The `Encoded` parameter is intentionally left as `unknown` (not
   * `Config`) so schemas with `withDecodingDefault` / transformations (where
   * the encoded shape differs from the decoded shape) satisfy the SPI
   * without casts. The registry only ever decodes `unknown` envelopes here,
   * so the precise encoded type is irrelevant at this boundary.
   *
   * Using `Codec` rather than `Schema` pins `DecodingServices = never`. If
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  /**
   * Config used when an instance has no config blob, such as the default
   * instance of a driver the user never configured.
   */
  readonly defaultConfig: () => Config;
  /**
   * Materialize one instance. The returned effect runs in a scope owned
   * by the registry; closing that scope releases every resource the
   * driver opened. Failures become unavailable shadow snapshots; the
   * driver MUST NOT throw defects.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  /**
   * Where the usage page reads this provider's token history, when it keeps
   * one. `UsageR` is what the reader needs, usually far less than `R`.
   */
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

/**
 * Heterogeneous-array convenience: the registry stores drivers as
 * `ReadonlyArray<AnyProviderDriver<R>>` where `R` is the union of all
 * registered drivers' env requirements.
 */
// `any` here intentionally erases the per-driver Config; the registry
// already decoded it before invoking `create`, so downstream code never
// needs the original `Config` type. Using `unknown` instead would force
// `create` callers into casts since `unknown` is not assignable to a
// concrete `Config` from inside the driver body.
export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

/** The services a driver's usage reader needs. */
export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;

/**
 * Registry queries over driver metadata, so callers never hardcode a
 * driver-kind union. `drivers` is the startup registry (`BUILT_IN_DRIVERS`
 * in the server); unknown kinds get `undefined` / `false` and fall back to
 * the caller's generic default.
 */

/** The registered driver for `kind`, or `undefined` for retired/fork drivers. */
export function getDriverByKind<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
): AnyProviderDriver<R, UsageR> | undefined {
  return drivers.find((driver) => driver.driverKind === kind);
}

/** Whether `kind` is registered, i.e. can run new work (not retired history). */
export function isRegisteredDriverKind<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
): boolean {
  return getDriverByKind(drivers, kind) !== undefined;
}

/** Default chat model for `kind`, or `undefined` when unknown. */
export function defaultModelForDriver<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
): string | undefined {
  return getDriverByKind(drivers, kind)?.metadata.defaultModel;
}

/** Default text-generation model for `kind`, or `undefined` when unknown. */
export function defaultTextGenerationModelForDriver<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
): string | undefined {
  return getDriverByKind(drivers, kind)?.metadata.defaultTextGenerationModel;
}

/**
 * Driver kinds that backstop text generation, in fallback order (lowest
 * `textGenerationFallbackPriority` first). Ties keep registry order.
 */
export function textGenerationFallbackDriverKinds<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
): ReadonlyArray<ProviderDriverKind> {
  return drivers
    .map((driver, index) => ({ driver, index }))
    .filter(({ driver }) => driver.metadata.textGenerationFallbackPriority !== undefined)
    .toSorted(
      (left, right) =>
        left.driver.metadata.textGenerationFallbackPriority! -
          right.driver.metadata.textGenerationFallbackPriority! || left.index - right.index,
    )
    .map(({ driver }) => driver.driverKind);
}

/** Normalize a probed version through the driver's hook, or return it as-is. */
export function normalizeDriverVersion<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
  version: string,
): string {
  return getDriverByKind(drivers, kind)?.metadata.normalizeVersion?.(version) ?? version;
}

/**
 * Whether `kind`'s instances belong in interactive pickers: registered and
 * not opted out via `pickerVisible: false`.
 */
export function isDriverPickerVisible<R, UsageR>(
  drivers: ReadonlyArray<AnyProviderDriver<R, UsageR>>,
  kind: ProviderDriverKind,
): boolean {
  const driver = getDriverByKind(drivers, kind);
  return driver !== undefined && driver.metadata.pickerVisible !== false;
}
