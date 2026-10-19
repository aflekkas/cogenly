import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectLabelsSettings,
  validateProjectLabelsSettingsSearch,
} from "../components/settings/ProjectLabelsSettings";

function SettingsProjectTagsRoute() {
  const search = Route.useSearch();
  return <ProjectLabelsSettings {...search} />;
}

export const Route = createFileRoute("/settings/project-tags")({
  validateSearch: validateProjectLabelsSettingsSearch,
  component: SettingsProjectTagsRoute,
});
