import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
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
import { useRightPanelStore } from "../rightPanelStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
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
import { NavigationHistoryButtons, NavigationHistoryShortcuts } from "./NavigationHistoryControls";
import { resolveWorkspaceTitlebarLayout } from "../workspaceTitlebar";
import { useIsMobile } from "../hooks/useMediaQuery";
import { routeHidesListColumn, SIDEBAR_TOGGLE_DISABLED_LABEL } from "./sidebar/listColumnRoutes";
import { useAgentsEmpty } from "../agents/agentsClient";
import { useUiStateStore } from "../uiStateStore";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { settingsReturnHref, SpaceRouteMemoryTracker } from "./sidebar/modes/spaceRouteMemory";
import {
  mainColumnCrampedBesidePanel,
  rightPanelFitsAgain,
  shouldReopenAutoClosedPanel,
  useListColumnLayoutStore,
  windowTooNarrowToDock,
} from "./sidebar/listColumnLayoutStore";
import { modeSwitchCrossfadeRunning } from "./sidebar/modes/modeSwitchMotion";
import {
  ListColumnPeekController,
  listColumnPeekPanelProps,
  listColumnPeekToggleHandlers,
  toggleListColumn,
  useListColumnPeekSurface,
} from "./sidebar/ListColumnPeek";
import { listColumnPeekAvailable } from "./sidebar/listColumnPeek.logic";
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
      if (!disabled) toggleListColumn(toggleSidebar);
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    // A focused desktop browser page forwards the chord as a menu action.
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle" && !disabled) toggleListColumn(toggleSidebar);
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
              // Hovering floats the collapsed column out; a click docks it.
              {...listColumnPeekToggleHandlers}
              onClick={(event) => {
                if (disabled) return;
                event.preventDefault();
                toggleListColumn(toggleSidebar);
              }}
            />
          }
        />
        <TooltipPopup side="bottom">
          {disabled
            ? SIDEBAR_TOGGLE_DISABLED_LABEL
            : `Toggle main sidebar${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
        </TooltipPopup>
      </Tooltip>
      <NavigationHistoryButtons />
    </div>
  );
}

/**
 * The back/forward pair when the sidebar toggle leads the rail: fixed in the
 * titlebar row just after the rail, where the macOS layout puts it after the
 * toggle instead (SidebarControl).
 */
function RailNavigationHistoryControl() {
  const { isMobile, mobileSheetMounted } = useSidebar();
  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-history-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
    >
      <NavigationHistoryButtons />
    </div>
  );
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
 * the main column cramped, or the window is too narrow for it, and brings it
 * back once there is room again (the panel closes or the window grows). Both
 * play the toggle's motion. The user's per-mode preference is untouched;
 * reopening the column by hand holds until a right panel opens again.
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
  // Before paint, so a narrow window never shows the column docked for a frame.
  useLayoutEffect(() => {
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

/**
 * The open inline right panel beside the main column: the project panel in
 * Projects mode, otherwise the routed thread's panel (browser, preview,
 * files). `closeForRoom` closes it as a last resort and remembers that, so
 * `ReopenAutoClosedPanel` can bring it back; the user's own close never does.
 */
function useInlineRightPanelRoom() {
  const navigate = useNavigate();
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const href = useLocation({ select: (location) => location.href });
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const projectPanelOpen = useParams({
    strict: false,
    select: (params) => "labelId" in params && Boolean(params.labelId),
  });
  const threadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const closeForRoom = () => {
    const { setAutoClosedPanel } = useListColumnLayoutStore.getState();
    if (sidebarMode === "projects" && projectPanelOpen) {
      setAutoClosedPanel({
        scope: "project",
        reopen: () => void navigate({ href }),
      });
      void navigate({ to: "/project" });
    } else if (routeThreadRef) {
      setAutoClosedPanel({
        scope: threadKey ?? "",
        reopen: () => useRightPanelStore.getState().show(routeThreadRef),
      });
      useRightPanelStore.getState().close(routeThreadRef);
    }
  };
  // What a remembered auto-close would reopen from the page shown now.
  const scopeShown = sidebarMode === "projects" && !projectPanelOpen ? "project" : threadKey;
  return { closeForRoom, scopeShown };
}

/**
 * Brings back a right panel that closed for lack of room, once it fits again
 * (the list column closes or the window grows) and the same page is shown.
 */
function ReopenAutoClosedPanel({
  scopeShown,
  roomAgain,
}: {
  scopeShown: string | null;
  roomAgain: boolean;
}) {
  const autoClosed = useListColumnLayoutStore((store) => store.autoClosedPanel);
  useEffect(() => {
    if (!autoClosed || !shouldReopenAutoClosedPanel(autoClosed, scopeShown, roomAgain)) return;
    useListColumnLayoutStore.getState().setAutoClosedPanel(null);
    autoClosed.reopen();
  }, [autoClosed, roomAgain, scopeShown]);
  return null;
}

/**
 * The list column, which while collapsed floats out over the page as the
 * pointer rests on the sidebar toggle (see ListColumnPeek). Its own component,
 * so a hover re-renders this frame and not the layout or the thread list.
 */
function ListColumnSidebar(props: ComponentProps<typeof Sidebar>) {
  const peek = useListColumnPeekSurface();
  return <Sidebar {...props} {...listColumnPeekPanelProps} peek={peek} />;
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
    rightPanelOpen: inlineRightPanelWidth !== null,
  });
  const peekAvailable = listColumnPeekAvailable({
    navRailVisible,
    listColumnOpen,
    listColumnHidden: listSidebarHidden,
  });
  // Docking the column beside the right panel would leave the main column
  // under its minimum even with the panel at its narrowest: only then does the
  // toggle close the panel, remembered so it returns when there is room.
  const { closeForRoom, scopeShown } = useInlineRightPanelRoom();
  const dismissed = useListColumnLayoutStore((store) => store.autoCollapseDismissed);
  const makeRoomToDock = mainColumnCramped && !listSidebarHidden ? closeForRoom : null;
  const roomForPanelAgain = rightPanelFitsAgain({
    viewportWidth,
    navRailWidth: titlebarLayout.navRailWidthPx,
    listColumnWidth,
    listColumnOpen: listColumnOpen && !listSidebarHidden,
  });
  // The column was docked by hand beside the panel and the window has since
  // shrunk past what both can share: the panel gives way, not the column.
  const panelOutOfRoom =
    mainColumnCramped && !listSidebarHidden && listColumnOpen && dismissed && !isMobile;
  useEffect(() => {
    if (panelOutOfRoom) closeForRoom();
  }, [panelOutOfRoom, closeForRoom]);
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
          void navigate({ href: settingsReturnHref() });
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
        cramped={(mainColumnCramped || windowTooNarrowToDock(viewportWidth)) && !listSidebarHidden}
        preferredOpen={preferredOpen}
      />
      <ReopenAutoClosedPanel scopeShown={scopeShown} roomAgain={roomForPanelAgain} />
      <ListColumnPeekController
        available={peekAvailable}
        pathname={pathname}
        makeRoom={makeRoomToDock}
      />
      <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
      <ProjectProjectionRetention />
      {navRailVisible ? (
        <SidebarNavRail showSidebarToggle={titlebarLayout.sidebarToggle === "rail-titlebar"} />
      ) : null}
      {/* Stays mounted on full-width pages, hidden by data-list-column-hidden
            (index.css), so a return shows the list in place, without a remount
            or a slide. */}
      <ListColumnSidebar
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
      </ListColumnSidebar>
      {children}
      {/* Without the rail, or after the macOS traffic lights beside it. A page
            without the list column keeps the button in place, disabled. */}
      <SidebarControl
        showButton={titlebarLayout.sidebarToggle === "fixed"}
        disabled={listSidebarHidden}
      />
      {titlebarLayout.sidebarToggle === "rail-titlebar" ? <RailNavigationHistoryControl /> : null}
      <NavigationHistoryShortcuts />
      <MainAppLocationTracker />
      <SpaceRouteMemoryTracker />
    </SidebarProvider>
  );
}
