import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectDraftView } from "../components/projects/ProjectDraftView";

// The project's detail is the right panel, hosted by the `_chat` layout
// (ProjectPanelHost); this route owns the main area: a new chat in the project.
function ProjectRoute() {
  const { environmentId, labelId } = Route.useParams();
  return (
    <ProjectDraftView
      environmentId={environmentId as EnvironmentId}
      labelId={labelId as ProjectLabelId}
    />
  );
}

export const Route = createFileRoute("/_chat/project/$environmentId/$labelId")({
  component: ProjectRoute,
});
