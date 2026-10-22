import { describe, expect, it } from "vite-plus/test";

import { NAV_RAIL_WIDTH_PX } from "./components/sidebar/navRail.logic";
import { resolveWorkspaceTitlebarLayout } from "./workspaceTitlebar";

describe("resolveWorkspaceTitlebarLayout", () => {
  it("keeps the browser layout: toggle in the rail's titlebar row, standard rail width", () => {
    const layout = resolveWorkspaceTitlebarLayout({
      navRailVisible: true,
      macosWindowControlsVisible: false,
    });
    expect(layout.sidebarToggle).toBe("rail-titlebar");
    expect(layout.navRailWidthPx).toBe(NAV_RAIL_WIDTH_PX);
    expect(layout.style["--nav-rail-width"]).toBe(`${NAV_RAIL_WIDTH_PX}px`);
    expect(layout.style["--workspace-controls-left"]).toBeUndefined();
  });

  it("keeps the rail flush at its browser width beside the traffic lights and fixes the toggle after them", () => {
    const layout = resolveWorkspaceTitlebarLayout({
      navRailVisible: true,
      macosWindowControlsVisible: true,
    });
    expect(layout.sidebarToggle).toBe("fixed");
    // The lights overhang the rail in the titlebar row; the rail does not widen
    // for them, so its buttons line up with the browser's.
    expect(layout.navRailWidthPx).toBe(NAV_RAIL_WIDTH_PX);
    expect(layout.style["--nav-rail-width"]).toBe(`${NAV_RAIL_WIDTH_PX}px`);
    // The toggle sits at the inset after the lights, and collapsed headers clear
    // it through the sidebar's default content inset.
    expect(layout.style["--workspace-controls-left"]).toContain("--desktop-window-controls-inset");
    expect(layout.style["--workspace-titlebar-content-left"]).toBeUndefined();
  });

  it("starts titlebar content after the rail when the toggle leads the rail", () => {
    const layout = resolveWorkspaceTitlebarLayout({
      navRailVisible: true,
      macosWindowControlsVisible: false,
    });
    expect(layout.style["--workspace-titlebar-content-left"]).toBe("0px");
  });

  it("falls back to a fixed toggle after the window controls without the rail", () => {
    const macos = resolveWorkspaceTitlebarLayout({
      navRailVisible: false,
      macosWindowControlsVisible: true,
    });
    expect(macos.sidebarToggle).toBe("fixed");
    expect(macos.navRailWidthPx).toBe(0);
    expect(macos.windowControlsStyle["--workspace-controls-left"]).toBeDefined();
    // Collapsed headers clear the fixed toggle through the sidebar's default.
    expect(macos.style["--workspace-titlebar-content-left"]).toBeUndefined();

    const browser = resolveWorkspaceTitlebarLayout({
      navRailVisible: false,
      macosWindowControlsVisible: false,
    });
    expect(browser.sidebarToggle).toBe("fixed");
    expect(browser.windowControlsStyle).toEqual({});
  });
});
