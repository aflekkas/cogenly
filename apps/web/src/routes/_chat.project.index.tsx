import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateProjectsOverviewSearch } from "../components/projects/ProjectsOverview";

// Projects live in Settings → Projects; old links land there.
export const Route = createFileRoute("/_chat/project/")({
  validateSearch: validateProjectsOverviewSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/project-tags", search, replace: true });
  },
});
