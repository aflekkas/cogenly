import type { ModelPreferences } from "@cogenly/contracts/settings";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  isProviderInstanceIdEnabled,
  isProviderTextGenerationCapable,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
  UNIVERSAL_CLIENT_PREFERENCE_KEYS,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection, readCustomModelEntries } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return isProviderInstanceIdEnabled(settings, selection.instanceId);
}

/**
 * One entry of the text-generation fallback chain: the driver kind in
 * preference order plus the cheap model to run on it. Callers with registry
 * access derive this from their startup registry
 * (`textGenerationFallbackDriverKinds`); the default below covers callers
 * without it and matches the registry for the built-in drivers.
 */
export interface TextGenerationFallbackDriver {
  readonly driver: ProviderDriverKind;
  readonly textGenerationModel: string;
}

const TEXT_GENERATION_FALLBACK_DRIVERS = ["codex", "claudeAgent", "muse"].map((driver) =>
  ProviderDriverKind.make(driver),
);

function defaultFallbackDrivers(): ReadonlyArray<TextGenerationFallbackDriver> {
  return TEXT_GENERATION_FALLBACK_DRIVERS.map((driver) => ({
    driver,
    textGenerationModel:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  }));
}

/**
 * The text generation model on the first built-in default instance, in
 * preference order, that `isEnabled` accepts. `null` when none is.
 *
 * The model is the driver's cheap default, unless `defaultModelSelection`
 * (the thread default) is one of that instance's custom models. A custom
 * model usually means a backend that may refuse the built-in default, and
 * the thread default, with its options, is known to work there.
 */
export function fallbackTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: {
    readonly defaultModelSelection?: ModelSelection | null;
    readonly fallbackDrivers?: ReadonlyArray<TextGenerationFallbackDriver>;
  },
): ModelSelection | null {
  const fallbackDrivers = options?.fallbackDrivers ?? defaultFallbackDrivers();
  const candidates = fallbackDrivers.map(
    ({ driver }) => [defaultInstanceIdForDriver(driver), driver] as const,
  );
  const match = candidates.find(([instanceId, driver]) => isEnabled(instanceId, driver));
  if (match === undefined) return null;
  const [instanceId, driver] = match;
  const threadDefault = options?.defaultModelSelection;
  const config = providerInstances[instanceId]?.config as { customModels?: unknown } | undefined;
  if (
    threadDefault?.instanceId === instanceId &&
    readCustomModelEntries(config?.customModels).some((entry) => entry.slug === threadDefault.model)
  ) {
    return threadDefault;
  }
  return {
    instanceId,
    model:
      fallbackDrivers.find((entry) => entry.driver === driver)?.textGenerationModel ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}

/** The model that writes commit messages and pull requests, when its provider can run it. */
export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isProviderInstanceIdEnabled(settings, selection.instanceId)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

/**
 * The model that writes review guides: its own setting when that provider can still run it,
 * otherwise whatever writes source control text.
 */
export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
): ModelSelection {
  const selection = settings.reviewGuideModelSelection;
  if (selection && isProviderInstanceIdEnabled(settings, selection.instanceId)) {
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    if (
      providers === undefined ||
      (provider?.enabled === true &&
        isProviderAvailable(provider) &&
        isProviderTextGenerationCapable(provider))
    ) {
      return selection;
    }
  }
  return resolveSourceControlWriterModelSelection(settings, providers);
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpLogsUrl: string | undefined;
}

function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
    otlpLogsUrl: normalizePersistedServerSettingString(input.observability?.otlpLogsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/** Upsert each patched entry; `null` removes it. Entries the patch omits are untouched. */
function mergeSettingsEntries<Value>(
  current: Readonly<Record<string, Value>>,
  patch: Readonly<Record<string, Value | null>>,
): Record<string, Value> {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) {
      next.delete(id);
    } else {
      next.set(id, config);
    }
  }
  return Object.fromEntries(next);
}

/** One model's default effort set or cleared; empty instances drop out of the map. */
function setModelEffortDefaultEntry(
  current: ServerSettings["modelEffortDefaults"],
  change: NonNullable<ServerSettingsPatch["setModelEffortDefault"]>,
): ServerSettings["modelEffortDefaults"] {
  const { [change.model]: _previous, ...rest } = current[change.provider] ?? {};
  const models = change.option === null ? rest : { ...rest, [change.model]: change.option };
  const { [change.provider]: _instance, ...others } = current;
  return Object.keys(models).length === 0 ? others : { ...others, [change.provider]: models };
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    migrateModelPreferences,
    migrateClientPreferences,
    setModelFavorites,
    setModelsHidden,
    setProviderModelOrder,
    setModelEffortDefault,
    providerModelPreferences,
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    worktreeCleanup: worktreeCleanupPatch,
    // Merged per entry below; its `null` removals must not reach deepMerge.
    sourceControlHosts: sourceControlHostsPatch,
    usageModelAliases: usageModelAliasesPatch,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const initialFavorites =
    patch.favorites ?? current.favorites ?? migrateModelPreferences?.favorites ?? null;
  const favorites =
    setModelFavorites?.reduce((current, change) => {
      const exists = current.some(
        (favorite) => favorite.provider === change.provider && favorite.model === change.model,
      );
      return change.favorite
        ? exists
          ? current
          : [...current, { provider: change.provider, model: change.model }]
        : current.filter(
            (favorite) => favorite.provider !== change.provider || favorite.model !== change.model,
          );
    }, initialFavorites ?? []) ?? initialFavorites;
  const initialModelPreferences =
    providerModelPreferences ??
    current.providerModelPreferences ??
    migrateModelPreferences?.providerModelPreferences ??
    null;
  let nextModelPreferences = initialModelPreferences;
  for (const change of setModelsHidden ?? []) {
    const preferences = nextModelPreferences?.[change.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const hiddenModels = preferences.hiddenModels.filter((model) => model !== change.model);
    if (change.hidden) hiddenModels.push(change.model);
    nextModelPreferences = {
      ...nextModelPreferences,
      [change.provider]: { ...preferences, hiddenModels },
    };
  }
  if (setProviderModelOrder) {
    const preferences = nextModelPreferences?.[setProviderModelOrder.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    nextModelPreferences = {
      ...nextModelPreferences,
      [setProviderModelOrder.provider]: {
        ...preferences,
        modelOrder: [...setProviderModelOrder.modelOrder],
      },
    };
  }
  const next = deepMerge(current, patchForMerge);
  for (const key of UNIVERSAL_CLIENT_PREFERENCE_KEYS) {
    const legacy = migrateClientPreferences?.[key];
    if (current[key] === null && patch[key] === undefined && legacy !== undefined)
      Object.assign(next, { [key]: legacy });
  }
  const nextWithReplacementsBase = {
    ...next,
    favorites,
    providerModelPreferences: nextModelPreferences,
    ...(setModelEffortDefault === undefined
      ? {}
      : {
          modelEffortDefaults: setModelEffortDefaultEntry(
            current.modelEffortDefaults,
            setModelEffortDefault,
          ),
        }),
    ...(worktreeCleanupPatch === undefined
      ? {}
      : {
          worktreeCleanup:
            worktreeCleanupPatch?.mode === "custom"
              ? {
                  mode: "custom" as const,
                  rules: {
                    worktreeKeepWhen: next.storageCleanup.worktreeKeepWhen,
                    worktreeAfterDays: next.storageCleanup.worktreeAfterDays,
                    worktreeSettledAfterDays: next.storageCleanup.worktreeSettledAfterDays,
                    worktreeOnMerge: next.storageCleanup.worktreeOnMerge,
                    worktreeOnDelete: next.storageCleanup.worktreeOnDelete,
                    worktreeUnchanged: next.storageCleanup.worktreeUnchanged,
                    ...(current.worktreeCleanup?.mode === "custom"
                      ? current.worktreeCleanup.rules
                      : {}),
                    ...worktreeCleanupPatch.rules,
                  },
                }
              : worktreeCleanupPatch,
        }),
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.worktreesDirectory !== undefined &&
    patch.worktreesDirectory !== current.worktreesDirectory
      ? {
          previousWorktreesDirectories: [
            ...current.previousWorktreesDirectories.filter(
              (directory) => directory !== patch.worktreesDirectory,
            ),
            ...(current.worktreesDirectory !== "" &&
            !current.previousWorktreesDirectories.includes(current.worktreesDirectory)
              ? [current.worktreesDirectory]
              : []),
          ],
        }
      : {}),
    // Per host, a patched field replaces the saved one: deepMerge would keep a cleared account pin.
    ...(sourceControlHostsPatch !== undefined
      ? {
          sourceControlHosts: {
            ...current.sourceControlHosts,
            ...Object.fromEntries(
              Object.entries(sourceControlHostsPatch).map(([kind, fields]) => [
                kind,
                { ...current.sourceControlHosts[kind], ...fields },
              ]),
            ),
          },
        }
      : {}),
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(usageModelAliasesPatch !== undefined
      ? {
          usageModelAliases: mergeSettingsEntries(
            current.usageModelAliases,
            usageModelAliasesPatch,
          ),
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(patch.reviewGuideModelSelection !== undefined
      ? { reviewGuideModelSelection: patch.reviewGuideModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}

/** Resolve legacy local preferences only until the environment has a saved value. */
export function resolveModelPreferences(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences> = {},
): ModelPreferences {
  return {
    favorites: settings.favorites ?? legacy.favorites ?? [],
    providerModelPreferences:
      settings.providerModelPreferences ?? legacy.providerModelPreferences ?? {},
  };
}

/** Empty legacy values do not claim ownership before another client can migrate its saved list. */
export function modelPreferencesMigrationPatch(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences>,
): ServerSettingsPatch | null {
  const favorites =
    settings.favorites === null && (legacy.favorites?.length ?? 0) > 0
      ? legacy.favorites
      : undefined;
  const providerModelPreferences =
    settings.providerModelPreferences === null &&
    Object.keys(legacy.providerModelPreferences ?? {}).length > 0
      ? legacy.providerModelPreferences
      : undefined;
  return favorites === undefined && providerModelPreferences === undefined
    ? null
    : {
        migrateModelPreferences: {
          ...(favorites === undefined ? {} : { favorites }),
          ...(providerModelPreferences === undefined ? {} : { providerModelPreferences }),
        },
      };
}
