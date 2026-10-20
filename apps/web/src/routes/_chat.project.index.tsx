import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectsOverview,
  validateProjectsOverviewSearch,
} from "../components/projects/ProjectsOverview";

function ProjectsOverviewRoute() {
  const search = Route.useSearch();
  return <ProjectsOverview {...search} />;
}

export const Route = createFileRoute("/_chat/project/")({
  validateSearch: validateProjectsOverviewSearch,
  component: ProjectsOverviewRoute,
});
