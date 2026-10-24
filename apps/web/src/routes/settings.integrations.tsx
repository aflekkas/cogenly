import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";
import { parseSetupSearch } from "../components/settings/integrationCatalog.logic";

/**
 * `?setup=<integration id or catalog id>` opens that account's or service's
 * setup step and scrolls to it; agents send users this link. It is consumed
 * once handled, so closing the step stays closed.
 */
function SettingsIntegrationsRoute() {
  const { setup } = Route.useSearch();
  const navigate = Route.useNavigate();
  const clearSetup = useCallback(
    () =>
      void navigate({
        search: ({ setup: _opened, ...previous }) => previous,
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );
  return <IntegrationsSettingsPanel setupTarget={setup} onSetupHandled={clearSetup} />;
}

export const Route = createFileRoute("/settings/integrations")({
  validateSearch: (raw: Record<string, unknown>): { setup?: string } => {
    const setup = parseSetupSearch(raw.setup);
    return setup === undefined ? {} : { setup };
  },
  component: SettingsIntegrationsRoute,
});
