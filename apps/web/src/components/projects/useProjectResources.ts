import type { EnvironmentId, ProjectLabelId, ProjectResource } from "@cogenly/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const EMPTY_RESOURCES: ReadonlyArray<ProjectResource> = [];

/** One project's files on disk, live: pushed as the folder changes. */
export function useProjectResources(environmentId: EnvironmentId, labelId: ProjectLabelId) {
  const query = useEnvironmentQuery(
    serverEnvironment.projectLabelResourcesLive({ environmentId, input: { id: labelId } }),
  );
  return {
    resources: query.data?.resources ?? EMPTY_RESOURCES,
    truncated: query.data?.truncated ?? false,
    error: query.error,
    isLoaded: query.data !== null,
  };
}
