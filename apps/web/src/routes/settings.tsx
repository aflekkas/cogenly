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
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_SCOPELESS_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  isSettingsSearchScopeAvailable,
} from "../components/settings/settingsSearch";

/**
 * Pages about one machine's own state, which are mostly machine-local
 * settings: the scope picks one machine and no project.
 */
const MACHINE_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/machines",
  "/settings/diagnostics",
  "/settings/storage",
]);

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" || searchTarget.scope === "project"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  // Unscoped pages handle their own targets; the Repository page follows
  // its own `repository` key.
  if (SETTINGS_SCOPELESS_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  // Keep the scope sentence on screen so the selection can be changed back.
  if (scope.kind === "unavailable")
    return <p className="px-3 text-sm text-muted-foreground sm:px-4">{scope.message}</p>;
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Reconnect {scope.label} to change its settings.
      </p>
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
        // Send every key so the retain middleware sees an explicit target
        // even when the choice is "all", which is the absence of a key.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            repository: next.repository,
            checkout: next.checkout,
          }),
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
