import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateProjectsOverviewSearch } from "../components/projects/ProjectsOverview";

// Projects moved out of Settings into the sidebar; old links land on the overview.
export const Route = createFileRoute("/settings/project-tags")({
  validateSearch: validateProjectsOverviewSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/project", search, replace: true });
  },
});
