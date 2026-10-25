import { isScratchProject } from "@cogenly/client-runtime/state/projects";
import type { EnvironmentId, ProjectId } from "@cogenly/contracts";
import { useCallback, useMemo } from "react";

import { useProjects, useServerConfigs } from "../state/entities";
import type { ThreadRepository } from "./projectLabels.logic";
import { useRepositoryNames } from "./useRepositoryNames";

/**
 * The repository a thread works in, named as the pickers name it, for move
 * menus (`threadFolderState`). Null for a machine's or a project's folder,
 * which any project can take.
 */
export function useThreadRepository(): (thread: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) => ThreadRepository | null {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const nameOf = useRepositoryNames();
  const byKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  return useCallback(
    (thread) => {
      const project = byKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (
        project === undefined ||
        isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
      )
        return null;
      return { projectId: project.id, name: nameOf(project) };
    },
    [byKey, nameOf, serverConfigs],
  );
}
