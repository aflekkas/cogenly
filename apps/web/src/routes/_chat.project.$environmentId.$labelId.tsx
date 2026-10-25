import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { projectSettingsSearch } from "../components/projects/ProjectsOverview";

// A project's page lives in Settings → Projects; links to the old page land there.
export const Route = createFileRoute("/_chat/project/$environmentId/$labelId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/project-tags",
      search: projectSettingsSearch(
        params.environmentId as EnvironmentId,
        params.labelId as ProjectLabelId,
      ),
      replace: true,
    });
  },
});
