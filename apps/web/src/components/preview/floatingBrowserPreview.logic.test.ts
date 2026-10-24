import type { PreviewNavStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampFloatingPreviewPosition,
  DEFAULT_FLOATING_PREVIEW_CORNER,
  floatingPreviewCornerPosition,
  floatingPreviewPaneFits,
  floatingPreviewTitle,
  migratePersistedPosition,
  nearestFloatingPreviewCorner,
  previewTabHasPage,
  shouldShowFloatingPreview,
} from "./floatingBrowserPreview.logic";

const page = (url: string, title = ""): PreviewNavStatus =>
  ({ _tag: "Success", url, title }) as PreviewNavStatus;

const visible = {
  targetKey: "thread-a\u0000tab-1",
  shownKeys: new Set<string>(),
  dismissedKey: null,
  sessionsLoaded: true,
  navStatus: page("https://example.com/"),
  thumbnailAvailable: true,
  poppedOut: false,
  paneFits: true,
};

describe("previewTabHasPage", () => {
  it("counts only tabs sent to a real page", () => {
    expect(previewTabHasPage(null)).toBe(false);
    expect(previewTabHasPage({ _tag: "Idle" })).toBe(false);
    expect(previewTabHasPage(page("about:blank"))).toBe(false);
    expect(previewTabHasPage(page("chrome://newtab/"))).toBe(false);
    expect(previewTabHasPage(page("http://localhost:5173/"))).toBe(true);
  });
});

describe("shouldShowFloatingPreview", () => {
  it("floats the last watched tab once no panel shows it", () => {
    expect(shouldShowFloatingPreview(visible)).toBe(true);
  });

  it("stays away while a panel shows the tab, after dismissal, or with nothing to show", () => {
    expect(shouldShowFloatingPreview({ ...visible, shownKeys: new Set([visible.targetKey]) })).toBe(
      false,
    );
    expect(shouldShowFloatingPreview({ ...visible, dismissedKey: visible.targetKey })).toBe(false);
    expect(shouldShowFloatingPreview({ ...visible, targetKey: null })).toBe(false);
    // A closed tab has no session, and a fresh tab has no page yet.
    expect(shouldShowFloatingPreview({ ...visible, navStatus: null })).toBe(false);
    expect(shouldShowFloatingPreview({ ...visible, navStatus: { _tag: "Idle" } })).toBe(false);
  });

  it("waits for the session list and needs a thumbnail source and room", () => {
    expect(shouldShowFloatingPreview({ ...visible, sessionsLoaded: false })).toBe(false);
    expect(shouldShowFloatingPreview({ ...visible, thumbnailAvailable: false })).toBe(false);
    expect(shouldShowFloatingPreview({ ...visible, paneFits: false })).toBe(false);
  });

  it("leaves a tab in the desktop's separate preview window to that window", () => {
    expect(shouldShowFloatingPreview({ ...visible, poppedOut: true })).toBe(false);
  });

  it("dismissing one tab leaves another tab free to float", () => {
    expect(shouldShowFloatingPreview({ ...visible, dismissedKey: "thread-a\u0000tab-2" })).toBe(
      true,
    );
  });
});

describe("floating preview corners", () => {
  const pane = { width: 1000, height: 800 };
  const card = { width: 200, height: 150 };
  const insets = { top: 40, bottom: 120 };

  it("defaults to the top right, inset like the docked details card", () => {
    expect(DEFAULT_FLOATING_PREVIEW_CORNER).toBe("top-right");
    expect(
      floatingPreviewCornerPosition(DEFAULT_FLOATING_PREVIEW_CORNER, pane, card, {
        top: 0,
        bottom: 120,
      }),
    ).toEqual({ x: 1000 - 200 - 12, y: 12 });
  });

  it("docks bottom corners above the composer and top corners under the header", () => {
    expect(floatingPreviewCornerPosition("bottom-right", pane, card, insets)).toEqual({
      x: 1000 - 200 - 12,
      y: 800 - 120 - 150 - 12,
    });
    expect(floatingPreviewCornerPosition("top-left", pane, card, insets)).toEqual({
      x: 12,
      y: 40 + 12,
    });
  });

  it("keeps right corners clear of the minimap strip", () => {
    expect(floatingPreviewCornerPosition("top-right", pane, card, { ...insets, right: 24 }).x).toBe(
      1000 - 24 - 200 - 12,
    );
    expect(floatingPreviewCornerPosition("top-left", pane, card, { ...insets, right: 24 }).x).toBe(
      12,
    );
  });

  it("never pushes a bottom corner above the top inset in a short pane", () => {
    const short = { width: 1000, height: 300 };
    expect(floatingPreviewCornerPosition("bottom-left", short, card, insets).y).toBe(52);
  });

  it("steps a right corner left of an open details card, and leaves left corners alone", () => {
    const details = { left: 700, bottom: 400 };
    const withDetails = { ...insets, detailsCard: details };
    expect(floatingPreviewCornerPosition("top-right", pane, card, withDetails).x).toBe(
      700 - 12 - 200,
    );
    expect(floatingPreviewCornerPosition("top-left", pane, card, withDetails).x).toBe(12);
    // A bottom corner below the card has nothing to avoid.
    expect(floatingPreviewCornerPosition("bottom-right", pane, card, withDetails).x).toBe(
      1000 - 200 - 12,
    );
  });

  it("only avoids the details card when it is not already clear of it", () => {
    const narrow = { width: 300, height: 800 };
    const details = { left: 100, bottom: 400 };
    // No room left of the card: the card stays inside the pane.
    expect(
      floatingPreviewCornerPosition("top-right", narrow, card, { ...insets, detailsCard: details })
        .x,
    ).toBeGreaterThanOrEqual(12);
  });

  it("fits only a pane wide enough that has room above the composer", () => {
    expect(floatingPreviewPaneFits(pane, card, 120)).toBe(true);
    expect(floatingPreviewPaneFits({ width: 500, height: 800 }, card, 120)).toBe(false);
    // 150 card + 24 margins + 400 composer does not fit in 500.
    expect(floatingPreviewPaneFits({ width: 1000, height: 500 }, card, 400)).toBe(false);
    expect(floatingPreviewPaneFits({ width: 1000, height: 500 }, card, 0)).toBe(true);
  });

  it("snaps a drop to the corner nearest the card's center", () => {
    expect(nearestFloatingPreviewCorner({ x: 10, y: 10 }, pane, card)).toBe("top-left");
    expect(nearestFloatingPreviewCorner({ x: 700, y: 20 }, pane, card)).toBe("top-right");
    expect(nearestFloatingPreviewCorner({ x: 100, y: 500 }, pane, card)).toBe("bottom-left");
    // The center decides, not the top-left: this card's center is right of middle.
    expect(nearestFloatingPreviewCorner({ x: 420, y: 600 }, pane, card)).toBe("bottom-right");
  });

  it("keeps a dragged card inside the pane", () => {
    expect(clampFloatingPreviewPosition({ x: -40, y: 900 }, pane, card)).toEqual({
      x: 0,
      y: 800 - 150,
    });
  });
});

describe("migratePersistedPosition", () => {
  it("resets the old default corner, which v1 stored for a card nobody had moved", () => {
    expect(migratePersistedPosition({ corner: "bottom-right", freePosition: null }, 1)).toEqual({
      corner: null,
      freePosition: null,
    });
  });

  it("keeps a corner or free position the user chose", () => {
    expect(migratePersistedPosition({ corner: "top-left", freePosition: null }, 1)).toEqual({
      corner: "top-left",
      freePosition: null,
    });
    expect(
      migratePersistedPosition({ corner: "bottom-right", freePosition: { x: 5, y: 9 } }, 1),
    ).toEqual({ corner: "bottom-right", freePosition: { x: 5, y: 9 } });
  });

  it("leaves a current-version bottom-right choice alone", () => {
    expect(migratePersistedPosition({ corner: "bottom-right", freePosition: null }, 2)).toEqual({
      corner: "bottom-right",
      freePosition: null,
    });
  });
});

describe("floating preview labels", () => {
  it("titles the card by page title, then host", () => {
    expect(floatingPreviewTitle(page("https://example.com/a", "Docs"))).toBe("Docs");
    expect(floatingPreviewTitle(page("https://example.com/a"))).toBe("example.com");
  });
});
