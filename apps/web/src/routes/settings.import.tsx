import { createFileRoute } from "@tanstack/react-router";

import { T3ImportSettings } from "../components/settings/T3ImportSettings";

export const Route = createFileRoute("/settings/import")({
  component: T3ImportSettings,
});
