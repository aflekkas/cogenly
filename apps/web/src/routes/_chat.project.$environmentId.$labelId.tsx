import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectView } from "../components/projects/ProjectView";

function ProjectViewRoute() {
  const { environmentId, labelId } = Route.useParams();
  return (
    <ProjectView
      // A fresh view per project, so an open editor never carries over.
      key={`${environmentId}:${labelId}`}
      environmentId={environmentId as EnvironmentId}
      labelId={labelId as ProjectLabelId}
    />
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$labelId")({
  component: ProjectViewRoute,
});
