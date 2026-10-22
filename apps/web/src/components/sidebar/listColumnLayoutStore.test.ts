import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  mainColumnCrampedBesidePanel,
  rightPanelFitsAgain,
  shouldReopenAutoClosedPanel,
  useListColumnLayoutStore,
} from "./listColumnLayoutStore";

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

  const layout = { navRailWidth: 48, listColumnWidth: 290 };

  it("keeps the list column and the panel together on a wide window", () => {
    // 2000px: 2000 - 48 - 290 leaves 1662 for the main column and a 540px panel.
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 2000, rightPanelOpen: true }),
    ).toBe(false);
    // 1440px still fits both: the panel shrinks toward 360, the main column stays over 640.
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1440, rightPanelOpen: true }),
    ).toBe(false);
  });

  it("calls a narrow window cramped only when the panel at its minimum leaves under 640px", () => {
    // 48 + 290 + 360 + 640 = 1338
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1338, rightPanelOpen: true }),
    ).toBe(false);
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1337, rightPanelOpen: true }),
    ).toBe(true);
    expect(
      mainColumnCrampedBesidePanel({ ...layout, viewportWidth: 1000, rightPanelOpen: false }),
    ).toBe(false);
  });

  it("fits the panel again once the column closes or the window grows", () => {
    const narrow = { ...layout, viewportWidth: 1200 };
    expect(rightPanelFitsAgain({ ...narrow, listColumnOpen: true })).toBe(false);
    expect(rightPanelFitsAgain({ ...narrow, listColumnOpen: false })).toBe(true);
    expect(rightPanelFitsAgain({ ...narrow, viewportWidth: 1400, listColumnOpen: true })).toBe(
      true,
    );
  });

  it("reopens a panel closed for room only on its own page and with room", () => {
    const closed = { scope: "env:thread", reopen: vi.fn() };
    expect(shouldReopenAutoClosedPanel(closed, "env:thread", true)).toBe(true);
    expect(shouldReopenAutoClosedPanel(closed, "env:thread", false)).toBe(false);
    expect(shouldReopenAutoClosedPanel(closed, "env:other", true)).toBe(false);
  });

  it("forgets the closed panel once any panel is open again", () => {
    const store = useListColumnLayoutStore.getState();
    store.setAutoClosedPanel({ scope: "env:thread", reopen: vi.fn() });
    store.setInlineRightPanelWidth(540);
    expect(useListColumnLayoutStore.getState().autoClosedPanel).toBeNull();
  });

  it("respects the user's own close: nothing was recorded, so nothing reopens", () => {
    const store = useListColumnLayoutStore.getState();
    store.setInlineRightPanelWidth(540);
    store.setInlineRightPanelWidth(null);
    const { autoClosedPanel } = useListColumnLayoutStore.getState();
    expect(shouldReopenAutoClosedPanel(autoClosedPanel, "env:thread", true)).toBe(false);
  });
});
