import { beforeEach, describe, expect, it } from "vite-plus/test";

import { mainColumnCrampedBesidePanel, useListColumnLayoutStore } from "./listColumnLayoutStore";

const initial = useListColumnLayoutStore.getState();

describe("listColumnLayoutStore", () => {
  beforeEach(() => useListColumnLayoutStore.setState(initial, true));

  it("remembers the list column per mode", () => {
    const { applyOpenChange } = useListColumnLayoutStore.getState();
    applyOpenChange("tasks", false);
    expect(useListColumnLayoutStore.getState().openByMode).toMatchObject({
      tasks: false,
      chats: true,
      agents: true,
    });
  });

  it("collapses on its own without touching the remembered preference", () => {
    const store = useListColumnLayoutStore.getState();
    store.setInlineRightPanelWidth(540);
    store.beginAutomaticChange(true);
    store.applyOpenChange("tasks", false);
    let state = useListColumnLayoutStore.getState();
    expect(state.autoCollapsed).toBe(true);
    expect(state.openByMode.tasks).toBe(true);

    // Reopened by hand beside the panel: holds until the panel opens again.
    state.applyOpenChange("tasks", true);
    state = useListColumnLayoutStore.getState();
    expect(state).toMatchObject({ autoCollapsed: false, autoCollapseDismissed: true });
    state.setInlineRightPanelWidth(600);
    expect(useListColumnLayoutStore.getState().autoCollapseDismissed).toBe(true);
    state.setInlineRightPanelWidth(null);
    state.setInlineRightPanelWidth(540);
    expect(useListColumnLayoutStore.getState().autoCollapseDismissed).toBe(false);
  });

  it("calls the main column cramped below the composer's comfortable width", () => {
    const layout = { navRailWidth: 48, listColumnWidth: 290 };
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1440, rightPanelWidth: 540 }),
    ).toBe(true);
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1920, rightPanelWidth: 540 }),
    ).toBe(false);
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1000, rightPanelWidth: null }),
    ).toBe(false);
  });
});
