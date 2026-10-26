import type { EnvironmentPresentation } from "../../state/environments";
import type { SettingsScopeSearch } from "./settingsScope";

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

export function settingsScopeEnvironmentAddress(environment: ScopeEnvironment) {
  if (!environment.displayUrl) return environment.environmentId;
  try {
    return new URL(environment.displayUrl).host || environment.displayUrl;
  } catch {
    return environment.displayUrl;
  }
}

export function settingsScopeEnvironmentLabels(
  environment: ScopeEnvironment,
  environments?: readonly ScopeEnvironment[],
) {
  const duplicates = environments?.filter(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  const address = settingsScopeEnvironmentAddress(environment);
  const secondary = duplicates?.some((other) => settingsScopeEnvironmentAddress(other) === address)
    ? environment.displayUrl || environment.environmentId
    : address;
  return {
    primary: environment.label,
    secondary: environments === undefined || duplicates?.length ? secondary : "",
  };
}

export function settingsScopeEnvironmentLabel(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
  return secondary ? `${primary} · ${secondary}` : primary;
}

/** Choosing a machine keeps the rest of the selection. */
export function selectMachineScope(
  search: SettingsScopeSearch,
  environmentId: string,
): SettingsScopeSearch {
  return { ...search, machine: environmentId };
}
