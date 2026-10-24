import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useMigrateModelPreferences,
} from "../../hooks/useSettings";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import type { SettingOverridingProject } from "./SettingInheritance";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  groupProjectOverridesByFolder,
  listProjectOverrides,
  listProviderInstanceOverrides,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planProviderInstanceOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target: project overrides applied on top of its environment. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  useMigrateModelPreferences(target?.environmentId ?? null, target?.settings ?? null);
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

/** Where the keys' effective values come from across the selected targets. */
export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (plan: ReturnType<typeof planScopedSettingsPatch>) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return;
      }
      void persistScopedSettingsPatch(
        plan,
        async (request) => {
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
            (scope) => !readEnvironmentScope(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
        if (failedEnvironments.length === 0) return;
        toastManager.add({
          type: "error",
          title: savedEnvironmentCount > 0 ? "Setting saved on some machines" : "Setting not saved",
          description: [
            ...failedEnvironments.map(
              ({ label, message }) => `Could not save on ${label}: ${message}`,
            ),
            ...(savedEnvironmentCount > 0
              ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
              : []),
          ].join("\n"),
        });
      });
    },
    [persistServer],
  );
}

/** Universal keys reach every connected machine, so the plan sees all of them. */
export function useUpdateScopedSettings() {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => run(planScopedSettingsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

/**
 * Drop the project overrides for `keys` so the project's repositories follow
 * All projects again. Rows also render outside the settings layout (provider cards,
 * dialogs), where there is no scope and nothing to clear.
 */
export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

/**
 * Clear `keys` on specific repository entries, from an overrides list. The
 * entries may sit on any machine, so the plan sees every one.
 */
export function useClearProjectOverrides() {
  const { environments } = useEnvironments();
  const run = useRunScopedPlan();
  return useCallback(
    (entries: readonly ProjectOverrideEntry[], keys: readonly ProjectScopedServerSettingKey[]) =>
      run(planProjectOverridesClear(environments, entries, keys)),
    [environments, run],
  );
}

/**
 * Overrides listed as projects, by the folder holding each repository.
 * Repositories in no project share one entry; `open` selects a project.
 */
export function overridingProjectsFrom(
  groups: ReturnType<typeof groupProjectOverridesByFolder>,
  open?: (folderId: string) => void,
): SettingOverridingProject[] {
  return groups.map(({ folder, entries }) =>
    folder
      ? {
          id: folder.id,
          label: folder.name,
          entries,
          open: open ? () => open(folder.id) : undefined,
        }
      : { id: "no-project", label: "Repositories in no project", entries },
  );
}

/**
 * Project overrides of a setting a machine page edits, on every connected
 * machine. A machine page has no project picker, so the projects only list.
 */
function useMachinePageOverrides(
  list: (environments: readonly EnvironmentPresentation[]) => readonly ProjectOverrideEntry[],
  format: (overrides: ProjectSettingsOverrides | undefined) => string | null,
) {
  const { environments } = useEnvironments();
  const context = useOptionalSettingsScope();
  const folders = context?.folders;
  const connected = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" && environment.serverConfig !== null,
      ),
    [environments],
  );
  const entries = list(connected);
  const projects = overridingProjectsFrom(groupProjectOverridesByFolder(entries, folders ?? []));
  const valueFor = (project: SettingOverridingProject) => {
    for (const entry of project.entries) {
      const value = format(
        connected.find((environment) => environment.environmentId === entry.environmentId)
          ?.serverConfig?.settings.projectSettingsOverrides[entry.projectId],
      );
      if (value !== null) return value;
    }
    return null;
  };
  return { projects, valueFor };
}

/** Projects whose own worktree cleanup replaces each machine's rules. */
export function useWorktreeCleanupOverrides() {
  const clear = useClearProjectOverrides();
  const overrides = useMachinePageOverrides(
    (environments) => listProjectOverrides(environments, ["worktreeCleanup"]),
    (entry) =>
      entry?.worktreeCleanup == null
        ? null
        : entry.worktreeCleanup.mode === "off"
          ? "Off"
          : "Custom",
  );
  return {
    ...overrides,
    onClear: (entries: readonly ProjectOverrideEntry[]) => clear(entries, ["worktreeCleanup"]),
  };
}

/** Projects that turn `instanceId` on or off for themselves. */
export function useProviderInstanceOverrides(instanceId: ProviderInstanceId) {
  const { environments } = useEnvironments();
  const run = useRunScopedPlan();
  const overrides = useMachinePageOverrides(
    (connected) => listProviderInstanceOverrides(connected, instanceId),
    (entry) => {
      const enabled = entry?.providerInstances?.[instanceId]?.enabled;
      return enabled === undefined ? null : enabled ? "On" : "Off";
    },
  );
  return {
    ...overrides,
    onClear: (entries: readonly ProjectOverrideEntry[]) =>
      run(planProviderInstanceOverridesClear(environments, entries, instanceId)),
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
