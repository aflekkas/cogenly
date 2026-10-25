/**
 * Which T3 Code settings an import brings over, decided without side effects.
 *
 * Provider instances are always planned: a thread can only resume through an
 * instance with T3's id and config dir. The rest (default models, favorites,
 * keybindings) is opt-in and never overrides something the user already set
 * in Cogenly. Secrets, sign-ins and environment variables are never read.
 */
import {
  KeybindingRule,
  ModelFavorites,
  ModelSelection,
  ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  type T3ImportProviderBinding,
  type T3ImportSettingChange,
} from "@cogenly/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const BUILT_IN_INSTANCE_IDS = new Set(["codex", "claudeAgent", "muse"]);

const decodeInstance = Schema.decodeUnknownOption(ProviderInstanceConfig);
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const decodeFavorites = Schema.decodeUnknownOption(ModelFavorites);
const decodeKeybinding = Schema.decodeUnknownOption(KeybindingRule);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The configured Claude/Codex home of an instance; empty means the CLI default. */
function homePathOf(instance: ProviderInstanceConfig | undefined): string {
  const homePath = record(instance?.config).homePath;
  return typeof homePath === "string" ? homePath.trim() : "";
}

export interface T3ProviderPlan {
  readonly bindings: ReadonlyArray<T3ImportProviderBinding>;
  readonly creates: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }>;
}

export function planProviderInstances(input: {
  /** T3's `settings.json`, parsed. */
  readonly t3Settings: unknown;
  readonly cogenlySettings: Pick<ServerSettings, "providerInstances">;
  /** Thread count per provider instance id among the threads in scope. */
  readonly threadsByInstance: ReadonlyMap<string, number>;
}): T3ProviderPlan {
  const t3Instances = record(record(input.t3Settings).providerInstances);
  const bindings: Array<T3ImportProviderBinding> = [];
  const creates: Array<T3ProviderPlan["creates"][number]> = [];
  for (const [instanceId, threads] of [...input.threadsByInstance].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const t3Instance = Option.getOrUndefined(decodeInstance(t3Instances[instanceId]));
    const existing = Object.hasOwn(input.cogenlySettings.providerInstances, instanceId)
      ? input.cogenlySettings.providerInstances[ProviderInstanceId.make(instanceId)]
      : undefined;
    const driver = t3Instance?.driver ?? existing?.driver ?? instanceId;
    const homePath = homePathOf(t3Instance);
    const withHome = homePath.length > 0 ? { homePath } : {};
    if (existing !== undefined) {
      const same = existing.driver === driver && homePathOf(existing) === homePath;
      bindings.push({
        instanceId,
        driver,
        threads,
        status: same ? "exists" : "conflict",
        ...withHome,
      });
      continue;
    }
    if (BUILT_IN_INSTANCE_IDS.has(instanceId)) {
      bindings.push({
        instanceId,
        driver,
        threads,
        status: homePath.length === 0 ? "builtin" : "conflict",
        ...withHome,
      });
      continue;
    }
    if (t3Instance === undefined) {
      bindings.push({ instanceId, driver, threads, status: "conflict" });
      continue;
    }
    // Environment variables may hold credentials; the user re-adds them in Cogenly.
    const { environment: _environment, ...instance } = t3Instance;
    creates.push({ instanceId: ProviderInstanceId.make(instanceId), instance });
    bindings.push({ instanceId, driver, threads, status: "create", ...withHome });
  }
  return { bindings, creates };
}

export interface T3PreferencesPlan {
  readonly patch: ServerSettingsPatch;
  readonly keybindings: ReadonlyArray<KeybindingRule>;
  readonly changes: ReadonlyArray<T3ImportSettingChange>;
}

const sameBinding = (left: KeybindingRule, right: KeybindingRule) =>
  left.key === right.key && (left.when ?? "") === (right.when ?? "");

export function planPreferences(input: {
  readonly t3Settings: unknown;
  readonly t3Keybindings: unknown;
  readonly cogenlySettings: Pick<ServerSettings, "favorites">;
  /** Top-level keys present in Cogenly's `settings.json`, i.e. set explicitly. */
  readonly cogenlySettingKeys: ReadonlySet<string>;
  readonly cogenlyKeybindings: ReadonlyArray<KeybindingRule>;
}): T3PreferencesPlan {
  const t3 = record(input.t3Settings);
  const patch: { -readonly [K in keyof ServerSettingsPatch]: ServerSettingsPatch[K] } = {};
  const changes: Array<T3ImportSettingChange> = [];
  for (const key of ["defaultModelSelection", "textGenerationModelSelection"] as const) {
    const selection = Option.getOrUndefined(decodeModelSelection(t3[key]));
    if (selection === undefined) continue;
    const label = `${selection.instanceId} · ${selection.model}`;
    if (input.cogenlySettingKeys.has(key)) {
      changes.push({
        setting: key,
        action: "keep",
        detail: `Already set in Cogenly (T3 Code: ${label})`,
      });
      continue;
    }
    patch[key] = selection;
    changes.push({ setting: key, action: "set", detail: label });
  }

  const t3Favorites = Option.getOrElse(decodeFavorites(t3.favorites), () => []);
  const current = input.cogenlySettings.favorites ?? [];
  const added = t3Favorites.filter(
    (favorite) =>
      !current.some((have) => have.provider === favorite.provider && have.model === favorite.model),
  );
  if (added.length > 0) {
    patch.favorites = [...current, ...added];
    changes.push({
      setting: "favorites",
      action: "add",
      detail: `${added.length} favorite models`,
    });
  } else if (t3Favorites.length > 0) {
    changes.push({ setting: "favorites", action: "keep", detail: "Already in Cogenly" });
  }

  const keybindings: Array<KeybindingRule> = [];
  let unsupported = 0;
  let alreadySet = 0;
  const rules = Array.isArray(input.t3Keybindings) ? input.t3Keybindings : [];
  for (const raw of rules) {
    const rule = Option.getOrUndefined(decodeKeybinding(raw));
    if (rule === undefined) {
      unsupported += 1;
      continue;
    }
    // A key Cogenly already uses (for any command) stays as Cogenly has it.
    if (
      input.cogenlyKeybindings.some((have) => sameBinding(have, rule)) ||
      keybindings.some((have) => sameBinding(have, rule))
    ) {
      alreadySet += 1;
      continue;
    }
    keybindings.push(rule);
  }
  if (keybindings.length > 0 || rules.length > 0) {
    changes.push({
      setting: "keybindings",
      action: keybindings.length > 0 ? "add" : "keep",
      detail: [
        `${keybindings.length} shortcuts added`,
        `${alreadySet} keys already bound in Cogenly`,
        ...(unsupported > 0 ? [`${unsupported} for commands Cogenly does not have`] : []),
      ].join(", "),
    });
  }
  return { patch, keybindings, changes };
}
