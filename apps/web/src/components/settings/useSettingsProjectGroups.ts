import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useProjectLabelDirectory } from "../../projectLabels/useProjectLabels";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { buildSettingsProjectFolders } from "./settingsScope";

/** Settings uses the same logical projects as the sidebar, sorted by display name. */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    return buildSidebarProjectSnapshots({
      projects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryEnvironmentId, projects, settings]);
}

/** The project folders a settings scope can select, across every environment. */
export function useSettingsProjectFolders() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const { active } = useProjectLabelDirectory(environmentIds);
  return useMemo(() => buildSettingsProjectFolders(active, projects), [active, projects]);
}
