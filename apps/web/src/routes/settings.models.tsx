import { createFileRoute } from "@tanstack/react-router";

import { ModelsSettingsPanel } from "../components/settings/ModelsSettings";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsPanel,
});
