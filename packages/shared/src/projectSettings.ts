import {
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  type ResolvedServerSettings,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@cogenly/contracts";
import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * Where a file-backed value came from: the setting, the repository's
 * cogenly.json, or the built-in default (reported as "environment", since
 * that is what the setting is when nothing set it).
 */
export type ProjectSettingSource = "environment" | "cogenly.json";

export interface ResolvedProjectFileSettings {
  /** Settings with every file-backed key resolved to a concrete value. */
  readonly settings: ResolvedServerSettings;
  /** Where each file-backed key's value came from. */
  readonly sources: Readonly<Record<ProjectFileBackedSettingKey, ProjectSettingSource>>;
}

/**
 * Settings for one repository: every file-backed key the setting leaves
 * unset is filled from the repository's decoded cogenly.json (null for a
 * missing or invalid file), then from the built-in default.
 */
export function resolveProjectFileSettings(
  settings: ServerSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectFileSettings {
  const effective: Record<string, unknown> = { ...settings };
  const sources = {} as Record<ProjectFileBackedSettingKey, ProjectSettingSource>;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    const { value, source } = resolveProjectFileBackedSetting(key, settings[key], projectFile);
    effective[key] = value;
    sources[key] = source;
  }
  return { settings: effective as ResolvedServerSettings, sources };
}

/**
 * The file and built-in tiers for one key, given the setting (`null` when
 * unset). For callers that hold the setting but only see the file later, such
 * as the git driver reading the cogenly.json of the checkout it just created.
 * Same chain as `resolveProjectFileSettings`.
 */
export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "cogenly.json" };
}

/**
 * The workspace mode a new thread starts in. A project the environment made
 * from just a name (a folder directly inside `ServerConfig.newProjectsRoot`)
 * has only its first commit, so until it has a thread, a new thread works in
 * the project checkout even when the default is a new worktree. Only the
 * setting's default is replaced: a cogenly.json still wins when the setting
 * is unset (the scaffold writes no cogenly.json).
 */
export function resolveNewThreadEnvMode(input: {
  readonly projectSettings: ResolvedProjectFileSettings;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = input.projectSettings.settings.defaultThreadEnvMode;
  if (
    configured === "local" ||
    input.projectHasThreads ||
    input.projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

/** The machine's worktree cleanup rules; artifact and log retention is separate. */
export function resolveWorktreeCleanup(settings: ServerSettings): WorktreeCleanupRules {
  const policy = settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeKeepWhen: settings.storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = settings.storageCleanup;
  return {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}
