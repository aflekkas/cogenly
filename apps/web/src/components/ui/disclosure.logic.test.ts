import { describe, expect, it } from "vite-plus/test";

import {
  disclosurePanelPresent,
  initialDisclosurePanelState,
  reconcileDisclosurePanel,
  settleDisclosurePanel,
} from "./disclosure.logic";

describe("disclosure panel state", () => {
  it("mounts open content at rest, without an enter animation", () => {
    const state = initialDisclosurePanelState(true, false);
    expect(state).toEqual({ mounted: true, animateEnter: false, moving: false, open: true });
    expect(disclosurePanelPresent(state, false)).toBe(true);
  });

  it("starts closed content unmounted and absent", () => {
    const state = initialDisclosurePanelState(false, false);
    expect(state.mounted).toBe(false);
    expect(disclosurePanelPresent(state, false)).toBe(false);
  });

  it("animates the first open only when asked to appear", () => {
    expect(initialDisclosurePanelState(true, true)).toEqual({
      mounted: true,
      animateEnter: true,
      moving: true,
      open: true,
    });
  });

  it("returns the same state when open does not change", () => {
    const state = initialDisclosurePanelState(false, false);
    expect(reconcileDisclosurePanel(state, false)).toBe(state);
  });

  it("arms the enter animation when an open mounts fresh content", () => {
    const opened = reconcileDisclosurePanel(initialDisclosurePanelState(false, false), true);
    expect(opened).toEqual({ mounted: true, animateEnter: true, moving: true, open: true });
  });

  it("keeps closing content mounted until the exit settles", () => {
    const closing = reconcileDisclosurePanel(initialDisclosurePanelState(true, false), false);
    expect(closing.mounted).toBe(true);
    expect(closing.moving).toBe(true);
    expect(disclosurePanelPresent(closing, false)).toBe(true);
    const settled = settleDisclosurePanel(closing);
    expect(settled).toEqual({ mounted: false, animateEnter: false, moving: false, open: false });
    expect(disclosurePanelPresent(settled, false)).toBe(false);
  });

  it("reopening mid-close keeps the content and does not re-arm the enter", () => {
    const closing = reconcileDisclosurePanel(initialDisclosurePanelState(true, false), false);
    const reopened = reconcileDisclosurePanel(closing, true);
    expect(reopened.mounted).toBe(true);
    expect(reopened.animateEnter).toBe(false);
    expect(reopened.moving).toBe(true);
  });

  it("settling an open panel only clears the motion flag", () => {
    const opened = reconcileDisclosurePanel(initialDisclosurePanelState(false, false), true);
    const settled = settleDisclosurePanel(opened);
    expect(settled).toEqual({ ...opened, moving: false });
    expect(settleDisclosurePanel(settled)).toBe(settled);
  });

  it("drops a closed panel at once under reduced motion", () => {
    const closing = reconcileDisclosurePanel(initialDisclosurePanelState(true, false), false);
    expect(disclosurePanelPresent(closing, true)).toBe(false);
    expect(disclosurePanelPresent(initialDisclosurePanelState(true, false), true)).toBe(true);
  });
});
