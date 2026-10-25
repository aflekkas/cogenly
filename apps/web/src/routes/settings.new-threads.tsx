import { createFileRoute } from "@tanstack/react-router";

import { NewThreadsSettingsPanel } from "../components/settings/NewThreadsSettings";

export const Route = createFileRoute("/settings/new-threads")({
  component: NewThreadsSettingsPanel,
});
