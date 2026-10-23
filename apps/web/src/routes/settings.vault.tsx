import { createFileRoute } from "@tanstack/react-router";

import { VaultSettings } from "../components/settings/VaultSettings";

export const Route = createFileRoute("/settings/vault")({
  component: VaultSettings,
});
