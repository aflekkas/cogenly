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

  it("gives the traffic lights the rail's titlebar row and moves the toggle below it", () => {
    const layout = resolveWorkspaceTitlebarLayout({
      navRailVisible: true,
      macosWindowControlsVisible: true,
    });
    expect(layout.sidebarToggle).toBe("rail-below-titlebar");
    // The lights end 70pt in; the rail clears them.
    expect(layout.navRailWidthPx).toBeGreaterThan(70);
    expect(layout.style["--nav-rail-width"]).toContain("--desktop-window-controls-right");
  });

  it("starts titlebar content after the rail, never after a fixed toggle, whenever the rail shows", () => {
    for (const macosWindowControlsVisible of [false, true]) {
      const layout = resolveWorkspaceTitlebarLayout({
        navRailVisible: true,
        macosWindowControlsVisible,
      });
      expect(layout.style["--workspace-titlebar-content-left"]).toBe("0px");
    }
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
