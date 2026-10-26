import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@cogenly/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  fallbackTextGenerationModelSelection,
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

describe("fallbackTextGenerationModelSelection", () => {
  it("ignores a configured non-default instance at machine scope, matching no fallback", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(providerInstances, (instanceId) =>
      instanceId === configured ? true : false,
    );
    expect(fallback).toBeNull();
  });
});

describe("serverSettings helpers", () => {
  it("legacy client migration seeds only unset fields and preserves explicit edits", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      clientAppearanceAccent: "green" as const,
      clientWordWrap: false,
    };
    const migrated = applyServerSettingsPatch(current, {
      migrateClientPreferences: {
        clientAppearanceAccent: "blue",
        clientAppearanceMode: "light",
        clientWordWrap: true,
      },
    });
    expect(migrated.clientAppearanceAccent).toBe("green");
    expect(migrated.clientAppearanceMode).toBe("light");
    expect(migrated.clientWordWrap).toBe(false);
    expect(
      applyServerSettingsPatch(migrated, {
        clientAppearanceMode: "dark",
        migrateClientPreferences: { clientAppearanceMode: "system" },
      }).clientAppearanceMode,
    ).toBe("dark");
  });

  it("sets and clears one model's default effort without touching others", () => {
    const codex = ProviderInstanceId.make("codex");
    const set = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelEffortDefault: {
        provider: codex,
        model: "gpt-6-astra",
        option: { id: "reasoningEffort", value: "high" },
      },
    });
    const both = applyServerSettingsPatch(set, {
      setModelEffortDefault: {
        provider: codex,
        model: "gpt-6.1-sol",
        option: { id: "reasoningEffort", value: "low" },
      },
    });
    expect(both.modelEffortDefaults[codex]).toEqual({
      "gpt-6-astra": { id: "reasoningEffort", value: "high" },
      "gpt-6.1-sol": { id: "reasoningEffort", value: "low" },
    });
    const one = applyServerSettingsPatch(both, {
      setModelEffortDefault: { provider: codex, model: "gpt-6-astra", option: null },
    });
    expect(one.modelEffortDefaults[codex]).toEqual({
      "gpt-6.1-sol": { id: "reasoningEffort", value: "low" },
    });
    expect(
      applyServerSettingsPatch(one, {
        setModelEffortDefault: { provider: codex, model: "gpt-6.1-sol", option: null },
      }).modelEffortDefaults,
    ).toEqual({});
  });

  it("changes a cleanup rule without replacing the machine's other rules", () => {
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeOnMerge: true, logsAfterDays: 30 },
    });
    expect(
      applyServerSettingsPatch(enabled, {
        storageCleanup: { worktreeAfterDays: null },
      }).storageCleanup,
    ).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: 7,
      worktreeOnMerge: true,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: 14,
      logsAfterDays: 30,
      dependenciesAfterDays: null,
    });
  });
  it("replaces SSH host lists when saving, editing, and removing hosts", () => {
    const host = { id: "mini", label: "Mac mini", target: "mini" };
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { deviceHosts: [host] });
    expect(saved.deviceHosts).toEqual([host]);
    const replacement = { ...host, target: "other-mini" };
    const edited = applyServerSettingsPatch(saved, { deviceHosts: [replacement] });
    expect(edited.deviceHosts).toEqual([replacement]);
    expect(applyServerSettingsPatch(edited, { deviceHosts: [] }).deviceHosts).toEqual([]);
  });

  it("replaces and clears conversation model defaults without retaining old options", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
      ]),
    });
    const selection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "sonnet");
    const updated = applyServerSettingsPatch(current, { defaultModelSelection: selection });
    expect(updated.defaultModelSelection).toEqual(selection);
    expect(
      applyServerSettingsPatch(updated, { defaultModelSelection: null }).defaultModelSelection,
    ).toBeNull();
  });

  it("ignores missing and blank persisted observability URLs", () => {
    expect(parsePersistedServerObservabilitySettings("{}")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: { otlpTracesUrl: "   ", otlpMetricsUrl: "", otlpLogsUrl: "   " },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("parses lenient persisted settings JSON and trims observability URLs", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
            otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
            otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      otlpLogsUrl: "http://localhost:4318/v1/logs",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces source control writer selection without retaining stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [{ id: "reasoningEffort", value: "high" }],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).sourceControlWriterModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("clears source control writer selection with null", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: null,
      }).sourceControlWriterModelSelection,
    ).toBeNull();
  });

  it("falls back from a disabled source control writer provider without clearing its selection", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };

    expect(isModelSelectionProviderEnabled(settings, sourceControlWriterModelSelection)).toBe(
      false,
    );
    expect(resolveSourceControlWriterModelSelection(settings, undefined)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from an unavailable source control writer provider", () => {
    const instanceId = ProviderInstanceId.make("missing_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "missing-model");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("missing-driver"),
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const unavailableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("missing-driver"),
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "unavailable",
      unavailableReason: "This provider driver is not available in this build.",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [unavailableProvider])).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from a writer provider that cannot generate application text", () => {
    const instanceId = ProviderInstanceId.make("acp_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "default");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const incapableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      supportsTextGeneration: false,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [incapableProvider])).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("stores background activity profiles as a versioned object and syncs legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(
      Duration.toMillis(Duration.minutes(15)),
    );
  });

  it("turns legacy interval patches into custom background activity overrides", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
    expect(resolveServerBackgroundActivitySettings(next).profile).toBe("balanced");
    expect(
      Duration.toMillis(resolveServerBackgroundActivitySettings(next).automaticGitFetchInterval),
    ).toBe(15_000);
  });

  it("preserves legacy background activity settings when applying an unrelated patch", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivityProfile: "performance" as const,
      automaticGitFetchInterval: Duration.seconds(7),
      providerHealthRefreshInterval: Duration.minutes(4),
    };

    const next = applyServerSettingsPatch(current, {
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(7),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
    expect(next.backgroundActivityProfile).toBe("performance");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(7_000);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(240_000);
  });

  it("does not reactivate dormant overrides from a concrete profile", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "battery-saver" as const,
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    };

    const next = applyServerSettingsPatch(current, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
  });

  it("prefers structured background activity settings over legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
      automaticGitFetchInterval: Duration.seconds(5),
      backgroundActivityProfile: "performance",
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
  });

  it("reconciles custom background activity back to a preset when overrides match the preset", () => {
    const custom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });
    const next = applyServerSettingsPatch(custom, {
      automaticGitFetchInterval: Duration.seconds(30),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("balanced");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(30_000);
  });

  it("drops custom overrides that duplicate the base profile", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(30),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
  });

  it("replaces the complete background override record", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(15),
          providerHealthRefreshInterval: Duration.minutes(3),
        },
      },
    });

    const next = applyServerSettingsPatch(current, {
      backgroundActivity: {
        overrides: {
          automaticGitFetchInterval: Duration.seconds(10),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(10),
      },
    });
  });

  it("keeps interval overrides supplied with a profile patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivityProfile: "performance",
      automaticGitFetchInterval: Duration.seconds(0),
      providerHealthRefreshInterval: Duration.minutes(4),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(0),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
  });

  it("ignores overrides attached to a concrete background profile", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "balanced",
        overrides: {
          pauseWhenOnBattery: true,
        },
      },
    });

    expect(resolved.pauseWhenOnBattery).toBe(false);
  });
});

describe("worktreesDirectory", () => {
  it("remembers previous custom locations so their worktrees stay managed", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreesDirectory: "/a" });
    expect(first.previousWorktreesDirectories).toEqual([]);
    const second = applyServerSettingsPatch(first, { worktreesDirectory: "/b" });
    expect(second.previousWorktreesDirectories).toEqual(["/a"]);
    const reset = applyServerSettingsPatch(second, { worktreesDirectory: "" });
    expect(reset.previousWorktreesDirectories).toEqual(["/a", "/b"]);
    const back = applyServerSettingsPatch(reset, { worktreesDirectory: "/a" });
    expect(back.previousWorktreesDirectories).toEqual(["/b"]);
  });
});

describe("synchronized model preferences", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const legacy = {
    favorites: [{ provider, model: "sol" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
  };

  it("keeps concurrent adds and removes of the same favorite idempotent", () => {
    const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] };
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, add);
    expect(applyServerSettingsPatch(first, add).favorites).toEqual([{ provider, model: "sol" }]);
    const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] };
    const removed = applyServerSettingsPatch(first, remove);
    expect(applyServerSettingsPatch(removed, remove).favorites).toEqual([]);
  });

  it("preserves unrelated models and providers during bulk visibility and order edits", () => {
    const otherProvider = ProviderInstanceId.make("claude_work");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: {
        ...legacy.providerModelPreferences,
        [otherProvider]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] },
      },
    });
    const mobile = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    const web = applyServerSettingsPatch(mobile, {
      setModelsHidden: [
        { provider, model: "astra", hidden: false },
        { provider, model: "sol", hidden: true },
      ],
      setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
    });
    expect(web.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["luna", "sol"],
      modelOrder: ["sol", "luna", "astra"],
    });
    expect(web.providerModelPreferences?.[otherProvider]).toEqual(
      initial.providerModelPreferences?.[otherProvider],
    );
    expect(
      applyServerSettingsPatch(web, {
        setProviderModelOrder: { provider, modelOrder: [] },
      }).providerModelPreferences?.[provider],
    ).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
  });

  it("migrates saved lists independently without claiming empty legacy lists", () => {
    expect(modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, {})).toBeNull();
    const patch = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const migrated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(resolveModelPreferences(migrated)).toEqual(legacy);
    expect(modelPreferencesMigrationPatch(migrated, legacy)).toBeNull();
    const favoritesOnly = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { favorites: [] });
    expect(modelPreferencesMigrationPatch(favoritesOnly, legacy)).toEqual({
      migrateModelPreferences: { providerModelPreferences: legacy.providerModelPreferences },
    });
  });

  it("keeps explicit clears when a delayed migration arrives from another device", () => {
    const staleMigration = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      favorites: [],
      providerModelPreferences: {},
    });
    expect(
      resolveModelPreferences(applyServerSettingsPatch(cleared, staleMigration), legacy),
    ).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });

  it("replaces visibility records so showing every model clears removed entries", () => {
    const migrated = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!,
    );
    const cleared = applyServerSettingsPatch(migrated, { providerModelPreferences: {} });
    expect(cleared.providerModelPreferences).toEqual({});
    expect(cleared.favorites).toEqual(legacy.favorites);
  });

  it("sets favorites without losing changes from other clients", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider, model: "astra", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider, model: "astra" },
    ]);
    const removed = applyServerSettingsPatch(second, {
      setModelFavorites: [{ provider, model: "sol", favorite: false }],
    });
    expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
    expect(
      applyServerSettingsPatch(removed, {
        setModelFavorites: [{ provider, model: "astra", favorite: false }],
      }).favorites,
    ).toEqual([]);
  });

  it("sets visibility against the latest state without replacing other models or their order", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: legacy.providerModelPreferences,
    });
    const first = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "sol", hidden: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    expect(second.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "sol", "luna"],
      modelOrder: ["sol"],
    });
    const restored = applyServerSettingsPatch(second, {
      setModelsHidden: [{ provider, model: "sol", hidden: false }],
    });
    expect(restored.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "luna"],
      modelOrder: ["sol"],
    });
    expect(
      applyServerSettingsPatch(restored, {
        setModelsHidden: [{ provider, model: "sol", hidden: false }],
      }).providerModelPreferences,
    ).toEqual(restored.providerModelPreferences);
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        setModelsHidden: [{ provider, model: "sol", hidden: true }],
      }).providerModelPreferences?.[provider]?.hiddenModels,
    ).toEqual(["sol"]);
  });

  it("keeps the same model on different provider instances as separate favorites", () => {
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider: otherProvider, model: "sol", favorite: true }],
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider: otherProvider, model: "sol" },
    ]);
    expect(
      applyServerSettingsPatch(second, {
        setModelFavorites: [{ provider, model: "sol", favorite: false }],
      }).favorites,
    ).toEqual([{ provider: otherProvider, model: "sol" }]);
  });

  it("keeps explicit edits when the same patch also carries a legacy migration", () => {
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      ...modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy),
      favorites: [],
      providerModelPreferences: {},
    });
    expect(resolveModelPreferences(edited, legacy)).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });
});
