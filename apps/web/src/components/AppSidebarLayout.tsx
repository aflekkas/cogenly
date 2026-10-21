import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { isElectron } from "../env";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useLegacySidebarEnabled } from "../hooks/useSettings";
import { usePanelAnimationSettings, usePanelNavigationSuppression } from "../panelAnimations";
import LegacyThreadSidebar from "./LegacySidebar";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarBrandWidthProbe, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarNavRail } from "./sidebar/SidebarNavRail";
import { resolveWorkspaceTitlebarLayout } from "../workspaceTitlebar";
import { useIsMobile } from "../hooks/useMediaQuery";
import { routeHidesListColumn, SIDEBAR_TOGGLE_DISABLED_LABEL } from "./sidebar/listColumnRoutes";
import { useAgentsEmpty } from "../agents/agentsClient";
import { useUiStateStore } from "../uiStateStore";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import {
  mainColumnCrampedBesidePanel,
  useListColumnLayoutStore,
} from "./sidebar/listColumnLayoutStore";
import { modeSwitchCrossfadeRunning } from "./sidebar/modes/modeSwitchMotion";
import { useProjects } from "../state/entities";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
} from "./threadSidebarWidth";
import { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function SidebarControl({
  showButton,
  disabled,
}: {
  showButton: boolean;
  /** No list column on this route: the button stays, disabled, and the shortcut is a no-op. */
  disabled: boolean;
}) {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B for bold; the toggle stays
        // available everywhere else, including the plain-text composer.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      if (!disabled) toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    // A focused desktop browser page forwards the chord as a menu action.
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle" && !disabled) toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [disabled, keybindings, toggleSidebar, usagePageOpen]);

  // The rail draws the toggle itself; this still owns the shortcut.
  if (!showButton) return null;

  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric.
    // The sheet owns its trigger until its closing transition unmounts it.
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              className="pointer-events-auto"
              aria-label="Toggle main sidebar"
              aria-disabled={disabled || undefined}
            />
          }
        />
        <TooltipPopup side="bottom">
          {disabled
            ? SIDEBAR_TOGGLE_DISABLED_LABEL
            : `Toggle main sidebar${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

// Moves through the app's route history like a browser's back/forward buttons.
function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  return null;
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

/**
 * Collapses the list column on its own while an inline right panel would leave
 * the main column cramped, and brings it back once there is room again (the
 * panel closes or the window grows). Both play the toggle's motion. The
 * user's per-mode preference is untouched; reopening the column by hand beside
 * the panel holds until the panel opens again.
 */
function ListColumnAutoCollapse({
  cramped,
  preferredOpen,
}: {
  cramped: boolean;
  /** The mode's remembered state, on a page that has the list column. */
  preferredOpen: boolean;
}) {
  const { setOpen, isMobile } = useSidebar();
  const autoCollapsed = useListColumnLayoutStore((store) => store.autoCollapsed);
  const dismissed = useListColumnLayoutStore((store) => store.autoCollapseDismissed);
  useEffect(() => {
    if (isMobile) return;
    const { beginAutomaticChange } = useListColumnLayoutStore.getState();
    if (cramped && preferredOpen && !autoCollapsed && !dismissed) {
      beginAutomaticChange(true);
      void setOpen(false);
    } else if (!cramped && autoCollapsed) {
      beginAutomaticChange(false);
      void setOpen(preferredOpen);
    }
  }, [autoCollapsed, cramped, dismissed, isMobile, preferredOpen, setOpen]);
  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  // Seeds server-side visited tracking from this browser's localStorage the
  useThreadVisitedMigration();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Usage, Projects and an empty Agents list are full-width pages: with the
  // rail there to navigate away, they have no list column. The mobile sheet
  // stays, since it is the only way back.
  const isMobile = useIsMobile();
  const navRailVisible = !isMobile && !legacySidebarEnabled;
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const agentsEmpty = useAgentsEmpty();
  const listSidebarHidden =
    navRailVisible &&
    routeHidesListColumn(pathname, { agentsEmpty: sidebarMode === "agents" && agentsEmpty });
  // A route change or a mode switch restores state instantly: the list
  // column's remembered open state included. Only the toggle animates it.
  const panelAnimationsSuppressed = usePanelNavigationSuppression(
    `${pathname}|${sidebarMode}|${listSidebarHidden ? "hidden" : "shown"}`,
  );
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  // The settings nav and the thread sidebar cross-fade when one replaces the
  // other, never on the first paint, nor inside a mode switch's own crossfade.
  const [sidebarView, setSidebarView] = useState({ settings: isOnSettings, swapped: false });
  if (sidebarView.settings !== isOnSettings) {
    setSidebarView({ settings: isOnSettings, swapped: !modeSwitchCrossfadeRunning() });
  }
  // The cross-fade runs once: a column shown again after a full-width page
  // (display: none) would otherwise replay its starting style.
  useEffect(() => {
    if (!sidebarView.swapped) return;
    const timeout = window.setTimeout(
      () => setSidebarView((view) => (view.swapped ? { ...view, swapped: false } : view)),
      1000,
    );
    return () => window.clearTimeout(timeout);
  }, [sidebarView]);
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  // Subscribed rather than read once: the fixed width still clamps to the live
  // window size.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  // The rail replaces the mode switcher and the Settings and Usage row. The
  // mobile sheet keeps those, and the legacy sidebar keeps its own layout.
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const titlebarLayout = resolveWorkspaceTitlebarLayout({
    navRailVisible,
    macosWindowControlsVisible: isMacosDesktop && !isWindowFullscreen,
  });
  const sidebarMinimumWidth = resolveThreadSidebarMinimumWidth(brandWidth);
  // The sidebar width is the list column alone; the rail takes its own room.
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(
    viewportWidth - titlebarLayout.navRailWidthPx,
    sidebarMinimumWidth,
  );
  const windowControlsInsetStyle = titlebarLayout.windowControlsStyle as CSSProperties;
  const listColumnWidth = clampThreadSidebarWidth(
    resolveInitialThreadSidebarWidth(null, viewportWidth),
    sidebarMinimumWidth,
    sidebarMaximumWidth,
  );
  // Each mode remembers its own open or closed list column, and a page without
  // the column leaves every mode's memory alone.
  const preferredOpen = useListColumnLayoutStore((store) => store.openByMode[sidebarMode]);
  const autoCollapsed = useListColumnLayoutStore((store) => store.autoCollapsed);
  const inlineRightPanelWidth = useListColumnLayoutStore((store) => store.inlineRightPanelWidth);
  const listColumnOpen = preferredOpen && !autoCollapsed;
  const mainColumnCramped = mainColumnCrampedBesidePanel({
    viewportWidth,
    navRailWidth: titlebarLayout.navRailWidthPx,
    listColumnWidth,
    rightPanelWidth: inlineRightPanelWidth,
  });
  const onListColumnOpenChange = (open: boolean) =>
    useListColumnLayoutStore.getState().applyOpenChange(sidebarMode, open);
  const sidebarProviderStyle = {
    "--sidebar-width": `${listColumnWidth}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...titlebarLayout.style,
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <SidebarProvider
      // Clip the main pane while it slides past the edge on sidebar close.
      className="h-dvh! min-h-0! overflow-x-clip"
      data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
      data-nav-rail={navRailVisible ? "" : undefined}
      data-list-column-hidden={listSidebarHidden ? "" : undefined}
      open={listColumnOpen}
      onOpenChange={onListColumnOpenChange}
      style={sidebarProviderStyle}
    >
      <ListColumnAutoCollapse
        cramped={mainColumnCramped && !listSidebarHidden}
        preferredOpen={preferredOpen}
      />
      <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
      <ProjectProjectionRetention />
      {navRailVisible ? (
        <SidebarNavRail showSidebarToggle={titlebarLayout.sidebarToggle === "rail-titlebar"} />
      ) : null}
      {/* Stays mounted on full-width pages, hidden by data-list-column-hidden
            (index.css), so a return shows the list in place, without a remount
            or a slide. */}
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        role="navigation"
        aria-label={isOnSettings ? "Settings" : "Threads"}
        aria-hidden={listSidebarHidden || undefined}
        inert={listSidebarHidden || undefined}
        // The list column starts after the rail and slides under it when collapsed.
        className={navRailVisible ? "left-(--nav-rail-width)" : undefined}
        // The narrow-window sidebar is a sheet, portaled outside the provider's styles.
        style={windowControlsInsetStyle}
      >
        <div
          key={isOnSettings ? "settings" : "threads"}
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col",
            sidebarView.swapped &&
              "motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-standard motion-safe:starting:opacity-0",
          )}
        >
          {isOnSettings ? (
            <>
              <SidebarChromeHeader isElectron={isElectron} />
              <SettingsSidebarNav pathname={pathname} />
            </>
          ) : legacySidebarEnabled ? (
            <LegacyThreadSidebar />
          ) : (
            <ThreadSidebar />
          )}
        </div>
      </Sidebar>
      {children}
      {/* Without the rail, or after the macOS traffic lights beside it. A page
            without the list column keeps the button in place, disabled. */}
      <SidebarControl
        showButton={titlebarLayout.sidebarToggle === "fixed"}
        disabled={listSidebarHidden}
      />
      <NavigationHistoryShortcuts />
      <MainAppLocationTracker />
    </SidebarProvider>
  );
}
