/**
 * The client half of a provider package.
 *
 * Every provider package exports a `ProviderClientDefinition` from its
 * `./client` entry point. Clients render settings, labels, and badges from
 * these definitions plus the server's `ServerProvider` snapshots, so a new
 * provider needs no per-driver branches in web or mobile.
 *
 * Definitions are browser- and React Native-safe: plain data and Effect
 * schemas, no platform UI imports.
 *
 * @module provider-core/client
 */
import type { ProviderDriverKind, UsageProviderKind } from "@cogenly/contracts";
import type * as Schema from "effect/Schema";

/**
 * A provider's instance settings schema. Fields carry `providerSettingsForm`
 * annotations, which the settings form renders generically.
 */
export type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/** An environment variable the settings UI offers for every instance of a driver. */
export interface ProviderEnvironmentField {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

/**
 * A provider glyph as plain data, so web and mobile can each draw it with
 * their own SVG renderer. Colors are per theme; a path without a fill or
 * gradient uses the icon's `fill`.
 */
export interface ProviderIcon {
  readonly viewBox: string;
  readonly fill: { readonly light: string; readonly dark: string };
  readonly paths: ReadonlyArray<{
    readonly d: string;
    readonly fillRule?: "evenodd" | "nonzero";
    readonly fill?: { readonly light: string; readonly dark: string };
    /** A brand gradient, the same in both themes. Coordinates are in viewBox units. */
    readonly gradient?: ProviderIconGradient;
  }>;
}

export interface ProviderIconGradient {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stops: ReadonlyArray<{ readonly offset: number; readonly color: string }>;
}

/** How one driver's usage reads on the usage page. */
export interface ProviderUsagePresentation {
  /** Bucket slug, usually the driver kind (`claude` for `claudeAgent`). */
  readonly providerKind: UsageProviderKind;
  readonly label: string;
  /** Bar/series colour token, e.g. `"#d97757"` or `"var(--contrast-foreground)"`. */
  readonly color: string;
}

/** What the onboarding wizard needs to install and sign in one driver. */
export interface ProviderOnboarding {
  /** Listed among the primary agents on the welcome wizard. */
  readonly primary?: boolean;
  /** Official standalone installers, keyed by the environment's platform family. */
  readonly installCommands?: {
    readonly windows: string;
    readonly posix: string;
  };
  /** Subcommand appended to the binary for interactive sign-in (`"login"`). */
  readonly loginSubcommand?: string;
  /** Binary name when settings carry no `binaryPath` (`"codex"`). */
  readonly binaryFallback?: string;
}

export interface ProviderClientDefinition {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  /** Omitted for drivers whose glyph a client still draws itself. */
  readonly icon?: ProviderIcon;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly environmentFields?: ReadonlyArray<ProviderEnvironmentField>;
  /** Whether the driver has a default instance backed by legacy `providers.<kind>` settings. */
  readonly hasDefaultInstance?: boolean;
  /**
   * Short warning badge beside every instance of the driver, such as "Beta".
   * It marks the driver kind, so built-in and custom instances show it alike.
   */
  readonly badgeLabel?: string;
  /**
   * Default chat model slug when the snapshot lists no models. Mirrors the
   * server driver's `metadata.defaultModel`; a test keeps the two in sync.
   */
  readonly defaultModel?: string;
  /**
   * Cheap model for text generation. Mirrors the server driver's
   * `metadata.defaultTextGenerationModel`.
   */
  readonly defaultTextGenerationModel?: string;
  /**
   * False hides the driver's instances from interactive pickers. Defaults
   * to `true` for registered drivers; unregistered drivers never show.
   */
  readonly pickerVisible?: boolean;
  /** Omitted when the driver keeps no usage history. */
  readonly usage?: ProviderUsagePresentation;
  /** Omitted when the driver needs no install/sign-in onboarding. */
  readonly onboarding?: ProviderOnboarding;
}

export function defineProviderClient<const Definition extends ProviderClientDefinition>(
  definition: Definition,
): Definition {
  return definition;
}

/** The provider definitions a client loaded, in presentation order. */
export interface ProviderClientRegistry {
  readonly definitions: ReadonlyArray<ProviderClientDefinition>;
  /** `undefined` for drivers this client does not ship, such as a fork's driver. */
  readonly get: (
    driverKind: ProviderDriverKind | undefined,
  ) => ProviderClientDefinition | undefined;
}

export function makeProviderClientRegistry(
  definitions: ReadonlyArray<ProviderClientDefinition>,
): ProviderClientRegistry {
  const byDriverKind = new Map<ProviderDriverKind, ProviderClientDefinition>();
  for (const definition of definitions) {
    if (byDriverKind.has(definition.driverKind)) {
      throw new Error(`Provider driver '${definition.driverKind}' is defined more than once.`);
    }
    byDriverKind.set(definition.driverKind, definition);
  }
  return {
    definitions,
    get: (driverKind) => (driverKind === undefined ? undefined : byDriverKind.get(driverKind)),
  };
}

/**
 * Registry queries over client definitions, so callers never hardcode a
 * driver-kind union. Unknown kinds get `undefined` / `false` and fall back
 * to the caller's generic presentation.
 */

/**
 * Whether `kind`'s instances belong in interactive pickers: registered and
 * not opted out via `pickerVisible: false`.
 */
export function isClientPickerVisible(
  registry: ProviderClientRegistry,
  kind: ProviderDriverKind,
): boolean {
  const definition = registry.get(kind);
  return definition !== undefined && definition.pickerVisible !== false;
}

/** Default chat model for `kind`, or `undefined` when unknown. */
export function defaultClientModelForDriver(
  registry: ProviderClientRegistry,
  kind: ProviderDriverKind,
): string | undefined {
  return registry.get(kind)?.defaultModel;
}

/** Default text-generation model for `kind`, or `undefined` when unknown. */
export function defaultClientTextGenerationModelForDriver(
  registry: ProviderClientRegistry,
  kind: ProviderDriverKind,
): string | undefined {
  return registry.get(kind)?.defaultTextGenerationModel;
}

export interface ResolvedUsagePresentation {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind | undefined;
}

/**
 * Presentation for a usage-bucket slug. Registered drivers supply their
 * label and colour; retired or fork slugs get a neutral row so the page
 * still renders their buckets.
 */
export function usagePresentationForKind(
  registry: ProviderClientRegistry,
  kind: UsageProviderKind,
): ResolvedUsagePresentation {
  const definition = registry.definitions.find(
    (candidate) => candidate.usage?.providerKind === kind,
  );
  if (definition?.usage) {
    return {
      label: definition.usage.label,
      color: definition.usage.color,
      driverKind: definition.driverKind,
    };
  }
  return {
    label: kind,
    color: "var(--muted-foreground)",
    driverKind: undefined,
  };
}

/**
 * Bar colour for a driver's usage windows, or `undefined` when the driver
 * is unknown or keeps no usage. Callers fall back to their neutral token.
 */
export function barColorForDriver(
  registry: ProviderClientRegistry,
  kind: ProviderDriverKind,
): string | undefined {
  return registry.get(kind)?.usage?.color;
}

/** Driver kinds listed among the primary agents on the welcome wizard. */
export function primaryOnboardingDriverKinds(
  registry: ProviderClientRegistry,
): ReadonlyArray<ProviderDriverKind> {
  return registry.definitions
    .filter((definition) => definition.onboarding?.primary === true)
    .map((definition) => definition.driverKind);
}
