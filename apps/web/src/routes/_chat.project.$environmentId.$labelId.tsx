import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectView } from "../components/projects/ProjectView";

function ProjectRoute() {
  const { environmentId, labelId } = Route.useParams();
  return (
    <ProjectView
      environmentId={environmentId as EnvironmentId}
      labelId={labelId as ProjectLabelId}
    />
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$labelId")({
  component: ProjectRoute,
});
