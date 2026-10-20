import { NAV_RAIL_WIDTH_PX } from "./components/sidebar/navRail.logic";

// Clears the fixed sidebar toggle once the sidebar no longer sits under it.
// With the navigation rail there is no fixed toggle: the rail clears the window
// controls itself, so the header keeps its gutter after the rail.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-nav-rail])_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-state=collapsed][data-nav-rail]_&]:pl-[max(var(--workspace-gutter-start),calc(var(--workspace-titlebar-content-left)-var(--nav-rail-width)))] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

// Where the fixed sidebar toggle sits beside the macOS traffic lights. The
// desktop preload keeps it in native points at any zoom level.
const MACOS_FIXED_TOGGLE_LEFT = "var(--desktop-window-controls-inset, 90px)";
// Trailing edge of the traffic lights, also kept in native points by the preload.
const MACOS_WINDOW_CONTROLS_RIGHT = "var(--desktop-window-controls-right, 70px)";
const MACOS_WINDOW_CONTROLS_CLEARANCE_PX = 10;
// The rail widens to hold the traffic lights in its titlebar row.
const MACOS_NAV_RAIL_WIDTH = `max(${NAV_RAIL_WIDTH_PX}px, calc(${MACOS_WINDOW_CONTROLS_RIGHT} + ${MACOS_WINDOW_CONTROLS_CLEARANCE_PX}px))`;
// The same width at 100% zoom, for layout math done in script.
const MACOS_NAV_RAIL_WIDTH_PX = 70 + MACOS_WINDOW_CONTROLS_CLEARANCE_PX;

export type SidebarTogglePlacement =
  /** The rail's titlebar row, centred like the mode buttons. */
  | "rail-titlebar"
  /** The rail's first button, below a titlebar row the traffic lights own. */
  | "rail-below-titlebar"
  /** Fixed in the titlebar, after the window controls. Layouts without the rail. */
  | "fixed";

export interface WorkspaceTitlebarLayout {
  readonly sidebarToggle: SidebarTogglePlacement;
  /** Approximate rail width in px for script layout math; 0 without the rail. */
  readonly navRailWidthPx: number;
  /** Custom properties for the sidebar wrapper. */
  readonly style: Readonly<Record<string, string>>;
  /** Custom properties the portaled mobile sheet also needs. */
  readonly windowControlsStyle: Readonly<Record<string, string>>;
}

/**
 * Lays out the titlebar strip around the native window controls. macOS paints
 * the traffic lights over the window's top-left corner unless it is fullscreen.
 * With the rail, the rail owns that corner and is wide enough to hold them, so
 * the sidebar and main pane start clear of them and their headers keep their
 * own insets. Without the rail, a fixed toggle sits after the window controls
 * and collapsed headers start after the toggle.
 */
export function resolveWorkspaceTitlebarLayout(input: {
  readonly navRailVisible: boolean;
  readonly macosWindowControlsVisible: boolean;
}): WorkspaceTitlebarLayout {
  const windowControlsStyle: Record<string, string> = input.macosWindowControlsVisible
    ? { "--workspace-controls-left": MACOS_FIXED_TOGGLE_LEFT }
    : {};

  if (!input.navRailVisible) {
    return {
      sidebarToggle: "fixed",
      navRailWidthPx: 0,
      style: { "--nav-rail-width": "0px", ...windowControlsStyle },
      windowControlsStyle,
    };
  }

  return {
    sidebarToggle: input.macosWindowControlsVisible ? "rail-below-titlebar" : "rail-titlebar",
    navRailWidthPx: input.macosWindowControlsVisible ? MACOS_NAV_RAIL_WIDTH_PX : NAV_RAIL_WIDTH_PX,
    style: {
      "--nav-rail-width": input.macosWindowControlsVisible
        ? MACOS_NAV_RAIL_WIDTH
        : `${NAV_RAIL_WIDTH_PX}px`,
      // Nothing fixed sits in the titlebar, so content only has to clear the rail.
      "--workspace-titlebar-content-left": "0px",
      ...windowControlsStyle,
    },
    windowControlsStyle,
  };
}
