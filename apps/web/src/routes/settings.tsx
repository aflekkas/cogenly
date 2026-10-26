import {
  Outlet,
  createFileRoute,
  redirect,
  useChildMatches,
  useLocation,
} from "@tanstack/react-router";
import { useLayoutEffect, type ReactNode } from "react";

import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SidebarInset } from "../components/ui/sidebar";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { settleModeSwitchMainPane } from "../components/sidebar/modes/modeSwitchMotion";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { SETTINGS_SCOPELESS_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer, SettingsPageMessage } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";

/**
 * Pages about one machine's own state, which are mostly machine-local
 * settings: the scope picks one machine.
 */
const MACHINE_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/machines",
  "/settings/diagnostics",
  "/settings/storage",
]);

/**
 * Search results and deep links (the hash) never gate the page: every row
 * renders at the selected scope, and one that can't vary there marks itself.
 */
function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  // Unscoped pages handle their own targets; the Repository page follows
  // its own `repository` key.
  if (SETTINGS_SCOPELESS_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  // Keep the scope sentence on screen so the machine can be changed back.
  if (scope.kind === "unavailable")
    return <SettingsPageMessage>{scope.message}</SettingsPageMessage>;
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageMessage>Reconnect {scope.label} to change its settings.</SettingsPageMessage>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const location = useLocation();
  const navigateToMainApp = useNavigateToMainApp();
  useEscapeToGoBack(navigateToMainApp);
  const { search, environment } = useSettingsScope();
  const contentScopeKey = MACHINE_SETTINGS_PATHS.has(location.pathname)
    ? environment?.environmentId
    : JSON.stringify(search);
  // The section's route, which changes only once its (lazily loaded) page
  // commits; until then the old page stays on screen. Hash and search changes
  // within a section keep it. Its commit is the new frame of the crossfade
  // into Settings (the rail's Settings button).
  const sectionRouteId = useChildMatches({ select: (matches) => matches[0]?.routeId });
  useLayoutEffect(() => {
    if (sectionRouteId !== undefined) settleModeSwitchMainPane();
  }, [sectionRouteId]);

  return (
    // Clips vertically only, so content gliding past the pane's new left edge
    // while the sidebar opens is not cut off there (panelFlip).
    <SidebarInset className="h-dvh min-h-0 overflow-y-clip overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <SettingsBreadcrumb pathname={location.pathname} />
        </WorkspacePageHeader>

        <div key={contentScopeKey} className="min-h-0 flex flex-1 flex-col">
          {/* Every page shares this frame and its width; a new section starts
              its own scroller at the top. */}
          <SettingsPageContainer key={sectionRouteId}>
            <SettingsScopeBoundary pathname={location.pathname}>
              <Outlet />
            </SettingsScopeBoundary>
          </SettingsPageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      machinePage={MACHINE_SETTINGS_PATHS.has(pathname)}
      onChange={(next) => {
        // Send every key so the retain middleware sees an explicit target.
        void navigate({
          to: pathname,
          search: () => ({ machine: next.machine, repository: next.repository }),
          hash: "",
          resetScroll: false,
          // A scope change filters the same page; back leaves the page instead.
          replace: true,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
