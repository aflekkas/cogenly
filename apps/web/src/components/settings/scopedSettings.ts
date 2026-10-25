import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  isNullableProjectSettingsOverride,
  isUniversalServerSettingKey,
  isMachineLocalProjectSettingKey,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  ServerSettings,
  type T3ProjectFile,
  type ServerSettingsPatch,
} from "@cogenly/contracts";
import type { EnvironmentConnectionPhase } from "@cogenly/client-runtime/connection";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  type ProjectSettingSource,
} from "@cogenly/shared/projectSettings";
import * as Equal from "effect/Equal";
import * as Cause from "effect/Cause";

import type { Project } from "../../types";
import { buildProviderInstanceOverridePatch } from "./ProviderSettingsPanel.logic";
import type { ResolvedSettingsScope, SettingsProjectFolder } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: {
      readonly capabilities: { readonly projectSettingsOverrides?: boolean | undefined };
    };
  } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

/**
 * A row at a project scope that can't take a project value. It still renders
 * inline, marked "Applies to all projects" with a link there, never a blocked
 * page: `SettingsRow` and every search or deep link rely on this.
 */
export function settingAppliesToAllProjects(row: {
  readonly scopeKind: ResolvedSettingsScope["kind"] | null;
  readonly serverScoped: boolean;
  readonly clientSetting: boolean;
  readonly settingKeys: readonly string[];
}): boolean {
  if (row.scopeKind !== "project") return false;
  return row.serverScoped ? !row.settingKeys.some(isProjectScopedSettingKey) : row.clientSetting;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnected<T extends ScopedSettingsEnvironment>(environment: T) {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/**
 * The representative supplies display values, never the set of write targets.
 * It is the scope's machine when connected: universal settings read the same
 * everywhere, and machine-local ones belong to that machine.
 */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(isConnected);
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === scope.machineId) ??
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

/** Key of a project's cogenly.json in the context's file map. */
export function scopedProjectFileKey(member: Pick<Project, "environmentId" | "id">) {
  return `${member.environmentId}:${member.id}`;
}

/**
 * One (environment, repository) pair the scope reads, with that repository's
 * effective settings. Outside a project there is one target, the scope's
 * machine, read without a project.
 */
export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  /** The environment's label. */
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
}

/** Effective settings per connected target: members at project scope, the machine otherwise. */
export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
  // Each member's decoded cogenly.json, keyed by `scopedProjectFileKey`, once
  // read. A member absent here has no file tier yet; null is a missing or
  // invalid file.
  projectFiles?: ReadonlyMap<string, T3ProjectFile | null>,
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const projectFile = projectFiles?.get(scopedProjectFileKey(member));
      const resolved =
        projectFile === undefined
          ? resolveProjectSettings(environment.serverConfig.settings, member.id)
          : resolveProjectSettings(environment.serverConfig.settings, member.id, null, projectFile);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
        },
      ];
    });
  }
  const machine =
    connectedEnvironments.find((environment) => environment.environmentId === scope.machineId) ??
    connectedEnvironments[0];
  return machine?.serverConfig
    ? [
        {
          environmentId: machine.environmentId,
          label: machine.label,
          projectId: null,
          settings: machine.serverConfig.settings,
          sources: resolveProjectSettings(machine.serverConfig.settings, null).sources,
        },
      ]
    : [];
}

/** A machine-local editor must not fall back to another machine's values or write targets. */
export function selectMachineLocalSettingsTargets<
  T extends { readonly environmentId: EnvironmentId },
>(scope: ResolvedSettingsScope, targets: readonly T[]): readonly T[] {
  return targets.filter((target) => target.environmentId === scope.machineId);
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

/** Whether the keys are overridden on every target, inherited on every target, or split. */
export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const sources = new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key])));
  return sources.size > 1
    ? "mixed"
    : sources.has("project")
      ? "project"
      : sources.has("cogenly.json")
        ? "cogenly.json"
        : "environment";
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
  /** The environment's settings before the write, to tell a dropped key from a saved one. */
  readonly previous: ServerSettings;
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" }>,
  environments: readonly ScopedSettingsEnvironment[],
  update: (
    current: ProjectSettingsOverrides,
    settings: ServerSettings,
    projectId: ProjectId,
    environmentId: EnvironmentId,
  ) => ProjectSettingsOverrides | null | undefined,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const member of scope.members) {
    const environment = byId.get(member.environmentId);
    if (
      !environment?.serverConfig ||
      environment.connection.phase !== "connected" ||
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
    ) {
      continue;
    }
    const settings = environment.serverConfig.settings;
    const entry = update(
      settings.projectSettingsOverrides[member.id] ?? {},
      settings,
      member.id,
      member.environmentId,
    );
    if (entry === undefined) continue;
    const existing = writes.get(member.environmentId);
    writes.set(member.environmentId, {
      environmentId: member.environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [member.id]: entry,
        },
      },
    });
  }
  return [...writes.values()];
}

/**
 * A storage cleanup edit also updates a machine whose worktree cleanup is
 * stored in the newer `worktreeCleanup` shape, so the two never disagree.
 */
function withWorktreeCleanupMirror(
  previous: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (
    previous.worktreeCleanup == null ||
    !patch.storageCleanup ||
    !Object.keys(patch.storageCleanup).some((key) => key.startsWith("worktree"))
  ) {
    return patch;
  }
  return {
    ...patch,
    worktreeCleanup: {
      mode: "custom",
      rules: {
        ...resolveWorktreeCleanup(previous, null),
        ...Object.fromEntries(
          Object.entries(patch.storageCleanup).filter(([key]) => key.startsWith("worktree")),
        ),
      },
    },
  };
}

/**
 * Outside a project, universal keys go to every connected environment (paired
 * machines sync them too, which covers offline ones) and machine-local keys to
 * the scope's machine only. A project scope writes the scopable keys into each
 * of its repositories' override entries; executable definitions stay on the selected machine. A write that
 * cannot reach every target it names is refused whole. Client keys always
 * persist locally.
 */
export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const isProjectScope = scope.kind === "project";
  const unscopableKeys = isProjectScope
    ? serverKeys.filter((key) => !isProjectScopedSettingKey(key))
    : [];
  const machineId = scope.kind === "environment" ? scope.environmentId : scope.machineId;
  const machine = environments.find((environment) => environment.environmentId === machineId);
  const machineLocalKeys = serverKeys.filter((key) => !isUniversalServerSettingKey(key));
  const machineUnreachable =
    (isProjectScope
      ? serverKeys.some(isMachineLocalProjectSettingKey)
      : machineLocalKeys.length > 0) && !(machine && isConnected(machine));
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0
      ? []
      : isProjectScope
        ? unscopableKeys.length > 0 || machineUnreachable
          ? []
          : projectOverrideWrites(
              scope,
              environments,
              (current, settings, projectId, environmentId) => {
                // Object-valued keys arrive as partial patches (the writing style
                // rows send one field); an override entry stores the whole value,
                // so complete the patch from the target's effective value.
                const effective = resolveProjectSettings(settings, projectId).settings;
                const next: Record<string, unknown> = { ...current };
                const entries = Object.entries(serverPatch).filter(
                  ([key]) => !isMachineLocalProjectSettingKey(key) || environmentId === machineId,
                );
                if (entries.length === 0) return undefined;
                for (const [key, value] of entries) {
                  if (key === "worktreeCleanup" && serverPatch.worktreeCleanup?.mode === "custom") {
                    next[key] = {
                      mode: "custom",
                      rules: {
                        ...resolveWorktreeCleanup(settings, projectId),
                        ...serverPatch.worktreeCleanup.rules,
                      },
                    };
                    continue;
                  }
                  // A picker's "Inherit" sends null; for keys whose override
                  // cannot store null that means remove the override.
                  if (
                    value === null &&
                    !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
                  ) {
                    delete next[key];
                    continue;
                  }
                  const base = effective[key as keyof ServerSettings];
                  next[key] =
                    isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
                }
                return next as ProjectSettingsOverrides;
              },
            )
        : (scope.kind === "all" || scope.kind === "environment") && !machineUnreachable
          ? environments.filter(isConnected).flatMap((environment) => {
              const previous = environment.serverConfig?.settings;
              if (!previous) return [];
              const environmentPatch = Object.fromEntries(
                Object.entries(serverPatch).filter(
                  ([key]) =>
                    isUniversalServerSettingKey(key) || environment.environmentId === machineId,
                ),
              ) as ServerSettingsPatch;
              if (Object.keys(environmentPatch).length === 0) return [];
              return [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  previous,
                  patch: withWorktreeCleanupMirror(previous, environmentPatch),
                },
              ];
            })
          : [];
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? "This setting applies to all projects. Choose All projects to change it."
          : isProjectScope
            ? "Connect a machine with this project's repositories, or update Cogenly on it, to save a project override."
            : `Connect ${machineUnreachable ? (machine?.label ?? "the machine") : "a machine"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

/** Remove the keys' project overrides so each repository follows All projects again. */
export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const serverWrites =
    scope.kind === "project"
      ? projectOverrideWrites(
          scope,
          environments,
          (_current, settings, projectId, environmentId) => {
            const selected = keys.filter(
              (key) => !isMachineLocalProjectSettingKey(key) || environmentId === scope.machineId,
            );
            return selected.length
              ? clearProjectSettingsOverrides(settings, projectId, selected)
              : undefined;
          },
        )
      : [];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0
        ? null
        : "Connect a machine with this project's repositories, or update Cogenly on it, to reset this override.",
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * The repositories on the selected environments that override `keys`. An
 * All projects edit leaves these untouched, so the row can name their
 * projects and offer to clear them.
 */
export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }]
        : [],
    );
  });
}

/**
 * Override entries grouped by the project folder holding the repository, in
 * folder order. Repositories outside every folder come last as one group
 * with no folder: the picker cannot open them, but they still count and can
 * be reset.
 */
export function groupProjectOverridesByFolder(
  entries: readonly ProjectOverrideEntry[],
  folders: readonly SettingsProjectFolder[],
): readonly {
  folder: SettingsProjectFolder | null;
  entries: readonly ProjectOverrideEntry[];
}[] {
  const holds = (folder: SettingsProjectFolder, entry: ProjectOverrideEntry) =>
    folder.members.some(
      (member) => member.environmentId === entry.environmentId && member.id === entry.projectId,
    );
  const grouped = folders.flatMap((folder) => {
    const held = entries.filter((entry) => holds(folder, entry));
    return held.length > 0 ? [{ folder, entries: held }] : [];
  });
  const loose = entries.filter((entry) => !folders.some((folder) => holds(folder, entry)));
  return loose.length > 0 ? [...grouped, { folder: null, entries: loose }] : grouped;
}

/** Repository entries that override whether `instanceId` is enabled. */
export function listProviderInstanceOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  instanceId: ProviderInstanceId,
): readonly ProjectOverrideEntry[] {
  return environments.flatMap((environment) =>
    Object.entries(environment.serverConfig?.settings.projectSettingsOverrides ?? {}).flatMap(
      ([projectId, entry]) =>
        entry.providerInstances?.[instanceId]?.enabled === undefined
          ? []
          : [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }],
    ),
  );
}

/**
 * Drop the named repositories' `enabled` override of `instanceId`, on every
 * connected machine holding one, so they follow the machine again.
 */
export function planProviderInstanceOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  instanceId: ProviderInstanceId,
) {
  const serverWrites = environments.filter(isConnected).flatMap((environment) => {
    const settings = environment.serverConfig?.settings;
    const projectIds = entries
      .filter((entry) => entry.environmentId === environment.environmentId)
      .map((entry) => entry.projectId);
    if (!settings || projectIds.length === 0) return [];
    return [
      {
        environmentId: environment.environmentId,
        label: environment.label,
        previous: settings,
        patch: {
          projectSettingsOverrides: buildProviderInstanceOverridePatch(
            settings,
            projectIds,
            instanceId,
            undefined,
          ),
        },
      },
    ];
  });
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the machines to reset these overrides.",
  };
}

/** Drop `keys` from the named repository entries so they follow All projects again. */
export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const { environmentId, projectId } of entries) {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig || environment.connection.phase !== "connected") continue;
    const settings = environment.serverConfig.settings;
    const existing = writes.get(environmentId);
    writes.set(environmentId, {
      environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [projectId]: clearProjectSettingsOverrides(settings, projectId, keys),
        },
      },
    });
  }
  const serverWrites = [...writes.values()];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites,
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the machines to reset these overrides.",
  };
}

/**
 * Whether a server kept `before` where `value` asked for a change. Objects are
 * compared field by field, so a nested key an older server dropped is caught
 * even when a sibling field saved. A null clears the field; strings may come
 * back trimmed.
 */
function writeWasDropped(value: unknown, before: unknown, saved: unknown): boolean {
  if (value === null) return before != null && Equal.equals(saved, before);
  if (isPlainObject(value) && !Array.isArray(before) && !Array.isArray(saved)) {
    const field = (source: unknown, key: string) =>
      isPlainObject(source) ? source[key] : undefined;
    return Object.entries(value).some(([key, next]) =>
      writeWasDropped(next, field(before, key), field(saved, key)),
    );
  }
  const unchanged =
    typeof value === "string" && typeof before === "string"
      ? value.trim() === before
      : Equal.equals(value, before);
  return !unchanged && Equal.equals(saved, before);
}

/**
 * An older server drops keys it does not know, top-level or nested, and still
 * succeeds. Left unreported, the row stays mixed forever.
 */
function droppedSettingKeys(write: ScopedServerWrite, saved: ServerSettings | undefined) {
  if (saved === undefined) return [];
  return Object.entries(write.patch).flatMap(([key, value]) =>
    writeWasDropped(
      value,
      write.previous[key as keyof ServerSettings],
      saved[key as keyof ServerSettings],
    )
      ? [key]
      : [],
  );
}

/** Wait for every target so a failed environment does not hide successful or later writes. */
export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{
    readonly _tag: "Success" | "Failure";
    readonly cause?: Cause.Cause<unknown>;
    readonly value?: ServerSettings;
  }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const saved = (index: number) => {
    const result = results[index];
    return (
      result?.status === "fulfilled" &&
      result.value._tag === "Success" &&
      droppedSettingKeys(plan.serverWrites[index]!, result.value.value).length === 0
    );
  };
  const failedEnvironments = plan.serverWrites.flatMap((environment, index) => {
    if (saved(index)) return [];
    const result = results[index];
    if (result?.status === "fulfilled" && result.value._tag === "Success") {
      return [
        {
          ...environment,
          message: "This machine does not support this setting. Update Cogenly on it.",
        },
      ];
    }
    const error: unknown =
      result?.status === "rejected"
        ? result.reason
        : result?.status === "fulfilled" && result.value.cause
          ? Cause.squash(result.value.cause)
          : undefined;
    return [
      {
        ...environment,
        message:
          error instanceof Error
            ? error.message
            : "The save failed. Try reconnecting and saving again.",
      },
    ];
  });
  const savedEnvironments = plan.serverWrites.filter((_, index) => saved(index));
  return {
    failedEnvironments,
    savedEnvironments,
    savedEnvironmentCount: savedEnvironments.length,
  };
}
