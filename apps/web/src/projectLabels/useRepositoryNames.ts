import type { EnvironmentId, ProjectId } from "@cogenly/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../state/environments";
import { useProjects } from "../state/entities";
import { repositoryNamesByCheckout } from "./repositoryPicker.logic";
import { useProjectLabelDirectory } from "./useProjectLabels";

/**
 * Names a checkout as every repository picker does: by its project's rule
 * (the home owner's repositories bare, any other `owner/name`), a repository
 * in no project by its own name, `owner/name` only where two would read the
 * same. Falls back to the folder name for a checkout it does not know.
 */
export function useRepositoryNames(): (repository: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
}) => string {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const { active } = useProjectLabelDirectory(environmentIds);
  const names = useMemo(() => repositoryNamesByCheckout(projects, active), [active, projects]);
  return useCallback(
    (repository) => names.get(`${repository.environmentId}:${repository.id}`) ?? repository.title,
    [names],
  );
}
