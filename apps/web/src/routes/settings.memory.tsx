import { createFileRoute } from "@tanstack/react-router";

import { MemorySettings } from "../components/settings/MemorySettings";

export const Route = createFileRoute("/settings/memory")({
  component: MemorySettings,
});
