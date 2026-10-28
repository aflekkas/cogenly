import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { MachinesSettingsPanel } from "../components/settings/MachinesSettings";

/** `?add=1` opens the Add machine dialog, as the command palette does. */
function SettingsMachinesRoute() {
  const { add } = Route.useSearch();
  const navigate = Route.useNavigate();
  const clearAdd = useCallback(
    () =>
      void navigate({
        search: ({ add: _opened, ...previous }) => previous,
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );
  return <MachinesSettingsPanel addRequested={add === true} onAddOpened={clearAdd} />;
}

export const Route = createFileRoute("/settings/machines")({
  validateSearch: (raw: Record<string, unknown>): { add?: true } =>
    raw.add === true || raw.add === 1 || raw.add === "1" ? { add: true } : {},
  component: SettingsMachinesRoute,
});
