import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import { movedGeneralSettingsPath } from "../components/settings/settingsSearch";

function SettingsGeneralRoute() {
  // Restoring defaults remounts the panel so every control re-reads its value.
  const [restoreSignal, setRestoreSignal] = useState(0);
  return (
    <GeneralSettingsPanel
      key={restoreSignal}
      onRestored={() => setRestoreSignal((value) => value + 1)}
    />
  );
}

export const Route = createFileRoute("/settings/general")({
  // Links to rows that moved to another page keep working, scope and anchor included.
  beforeLoad: ({ location }) => {
    const movedTo = movedGeneralSettingsPath(location.hash);
    if (movedTo) {
      throw redirect({ to: movedTo, search: true, hash: location.hash, replace: true });
    }
  },
  component: SettingsGeneralRoute,
});
