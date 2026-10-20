import { NAV_RAIL_WIDTH_PX } from "./components/sidebar/navRail.logic";

// Clears the fixed sidebar toggle once the sidebar no longer sits under it.
// Beside the rail, only the macOS toggle after the traffic lights is fixed; the
// header otherwise keeps its gutter after the rail.
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
  /** Fixed in the titlebar row, just after the macOS window controls. */
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
 * There the rail widens to hold them in its titlebar row, and the sidebar
 * toggle sits fixed just after them, centred on the same row; the rail's
 * buttons start below that row, and collapsed headers start after the toggle.
 * Without the traffic lights the toggle leads the rail in its titlebar row.
 * Without the rail, a fixed toggle sits after the window controls.
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

  if (input.macosWindowControlsVisible) {
    return {
      sidebarToggle: "fixed",
      navRailWidthPx: MACOS_NAV_RAIL_WIDTH_PX,
      // Collapsed headers clear the fixed toggle through the sidebar's default
      // --workspace-titlebar-content-left.
      style: { "--nav-rail-width": MACOS_NAV_RAIL_WIDTH, ...windowControlsStyle },
      windowControlsStyle,
    };
  }

  return {
    sidebarToggle: "rail-titlebar",
    navRailWidthPx: NAV_RAIL_WIDTH_PX,
    style: {
      "--nav-rail-width": `${NAV_RAIL_WIDTH_PX}px`,
      // Nothing fixed sits in the titlebar, so content only has to clear the rail.
      "--workspace-titlebar-content-left": "0px",
    },
    windowControlsStyle,
  };
}

/**
 * How far the chat header floats over the top of a timeline scroller: the
 * scroller's scroll-padding-top (index.css, .messages-timeline-scroll). Code
 * that scrolls a row to the top of the viewport adds it so the row lands
 * below the header instead of under its fade.
 */
export function timelineHeaderInset(scroller: Element | null | undefined): number {
  if (!scroller) return 0;
  const inset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop);
  return Number.isFinite(inset) ? inset : 0;
}
