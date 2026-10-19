import { createFileRoute } from "@tanstack/react-router";

import { DataSettings } from "../components/settings/DataSettings";

export const Route = createFileRoute("/settings/data")({
  component: DataSettings,
});
