import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { projectLabelsOn } from "../../projectLabels/projectLabels.logic";
import { useProjectLabelDirectory } from "../../projectLabels/useProjectLabels";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { buildSettingsProjectFolders } from "./settingsScope";

/**
 * Settings uses the same logical projects as the sidebar, sorted by display
 * name. The scratch folder behind unfiled chats is no repository to manage.
 */
export function useSettingsProjectGroups() {
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => !project.isScratch),
    [allProjects],
  );
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
  // Every machine's copy, so a folder holds its repositories on each machine.
  return useMemo(
    () =>
      buildSettingsProjectFolders(
        environmentIds.flatMap((environmentId) => projectLabelsOn(active, environmentId)),
        projects,
      ),
    [active, environmentIds, projects],
  );
}
