import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectsOverview,
  validateProjectsOverviewSearch,
} from "../components/projects/ProjectsOverview";
import { ProjectView } from "../components/projects/ProjectView";

// Settings → Projects: the grid, or one project's page when the search names it.
function ProjectsSettingsRoute() {
  const search = Route.useSearch();
  if (search.projectEnvironmentId !== undefined && search.projectLabelId !== undefined) {
    return (
      <ProjectView environmentId={search.projectEnvironmentId} labelId={search.projectLabelId} />
    );
  }
  return <ProjectsOverview {...search} />;
}

export const Route = createFileRoute("/settings/project-tags")({
  validateSearch: validateProjectsOverviewSearch,
  component: ProjectsSettingsRoute,
});
