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

export const ALL_PROJECTS_VALUE = "all";

/** Choosing a project keeps the machine; a legacy checkout narrowing is dropped. */
export function selectProjectScope(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = { ...search };
  delete next.checkout;
  delete next.project;
  if (value !== ALL_PROJECTS_VALUE) next.project = value;
  return next;
}

/** Choosing a machine keeps the project; a legacy checkout narrowing is dropped. */
export function selectMachineScope(
  search: SettingsScopeSearch,
  environmentId: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = { ...search, machine: environmentId };
  delete next.checkout;
  return next;
}
