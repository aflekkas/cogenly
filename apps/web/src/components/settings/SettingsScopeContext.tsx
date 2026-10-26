import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

function useResolvedSettingsScope(search: SettingsScopeSearch, machinePage: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useMemo(
    () =>
      resolveSettingsScope(search, availableEnvironments, {
        machinePage,
        primaryEnvironmentId,
      }),
    [availableEnvironments, machinePage, primaryEnvironmentId, search],
  );
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments);
    // The representative target supplies display values.
    const target = targets[0] ?? null;
    // The machine machine-local settings belong to, as the machine picker names it.
    const machine =
      availableEnvironments.find((environment) => environment.environmentId === scope.machineId) ??
      null;
    return { scope, groups, search, ...selected, targets, target, machine };
  }, [availableEnvironments, groups, primaryEnvironmentId, scope, search]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      /** The page is about one machine's own state. */
      machinePage: boolean;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  machinePage = false,
}: {
  machinePage?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, machinePage);
  const value = useMemo(
    () => ({ ...resolved, machinePage, selectScope: onChange }),
    [machinePage, onChange, resolved],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
