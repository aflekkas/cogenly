import type { PreviewNavStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clampFloatingPreviewPosition,
  floatingPreviewCornerPosition,
  floatingPreviewTitle,
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

  it("docks bottom corners above the composer and top corners under the header", () => {
    expect(floatingPreviewCornerPosition("bottom-right", pane, card, insets)).toEqual({
      x: 1000 - 200 - 16,
      y: 800 - 120 - 150 - 16,
    });
    expect(floatingPreviewCornerPosition("top-left", pane, card, insets)).toEqual({
      x: 16,
      y: 40 + 16,
    });
  });

  it("keeps right corners clear of the minimap strip", () => {
    expect(floatingPreviewCornerPosition("top-right", pane, card, { ...insets, right: 24 }).x).toBe(
      1000 - 24 - 200 - 16,
    );
    expect(floatingPreviewCornerPosition("top-left", pane, card, { ...insets, right: 24 }).x).toBe(
      16,
    );
  });

  it("never pushes a bottom corner above the top inset in a short pane", () => {
    const short = { width: 1000, height: 300 };
    expect(floatingPreviewCornerPosition("bottom-left", short, card, insets).y).toBe(56);
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

describe("floating preview labels", () => {
  it("titles the card by page title, then host", () => {
    expect(floatingPreviewTitle(page("https://example.com/a", "Docs"))).toBe("Docs");
    expect(floatingPreviewTitle(page("https://example.com/a"))).toBe("example.com");
  });
});
