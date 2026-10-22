import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

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
  component: SettingsGeneralRoute,
});
