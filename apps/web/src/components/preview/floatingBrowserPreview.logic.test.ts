import type { PreviewNavStatus } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorResizedFloatingPreview,
  clampFloatingPreviewPosition,
  DEFAULT_FLOATING_PREVIEW_CORNER,
  clampFloatingPreviewToArea,
  DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT,
  dismissFloatingPreviewThread,
  FLOATING_PREVIEW_CARD_HEIGHT,
  FLOATING_PREVIEW_CARD_WIDTH,
  FLOATING_PREVIEW_MAX_DISMISSED_THREADS,
  FLOATING_PREVIEW_MAX_PAGE_ASPECT,
  FLOATING_PREVIEW_MIN_PAGE_ASPECT,
  FLOATING_PREVIEW_TITLE_HEIGHT,
  FLOATING_PREVIEW_MAX_WIDTH,
  FLOATING_PREVIEW_MIN_WIDTH,
  floatingPreviewCardSize,
  floatingPreviewCornerPosition,
  floatingPreviewMinCardSize,
  floatingPreviewPageAspect,
  floatingPreviewPageFrame,
  floatingPreviewPaneArea,
  floatingPreviewPaneFits,
  floatingPreviewResizeHandle,
  floatingPreviewTitle,
  migratePersistedFloatingPreview,
  nearestFloatingPreviewCorner,
  oppositeFloatingPreviewCorner,
  previewTabHasPage,
  resizeFloatingPreviewWidth,
  resolveFloatingPreviewDriver,
  restoreFloatingPreviewThread,
  shouldShowFloatingPreview,
} from "./floatingBrowserPreview.logic";

const page = (url: string, title = ""): PreviewNavStatus =>
  ({ _tag: "Success", url, title }) as PreviewNavStatus;

const visible = {
  targetKey: "thread-a\u0000tab-1",
  shownKeys: new Set<string>(),
  dismissed: false,
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
    expect(shouldShowFloatingPreview({ ...visible, dismissed: true })).toBe(false);
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

describe("migratePersistedFloatingPreview", () => {
  it("resets the old default corner, which v1 stored for a card nobody had moved", () => {
    expect(
      migratePersistedFloatingPreview({ corner: "bottom-right", freePosition: null }, 1),
    ).toEqual({ corner: null, freePosition: null, width: null, dismissedThreads: {} });
  });

  it("keeps a corner and width the user chose", () => {
    expect(
      migratePersistedFloatingPreview({ corner: "top-left", freePosition: null, width: 320 }, 2),
    ).toEqual({ corner: "top-left", freePosition: null, width: 320, dismissedThreads: {} });
  });

  it("drops a pre-v3 free position, which was in window coordinates", () => {
    expect(
      migratePersistedFloatingPreview({ corner: "bottom-right", freePosition: { x: 5, y: 9 } }, 2)
        .freePosition,
    ).toBeNull();
  });

  it("keeps a current free position and the threads whose card was closed", () => {
    const persisted = {
      corner: "bottom-right",
      freePosition: { x: 5, y: 9 },
      width: null,
      dismissedThreads: { "env\u0000thread-a": true },
    };
    expect(migratePersistedFloatingPreview(persisted, 3)).toEqual(persisted);
  });
});

describe("per-thread dismissal", () => {
  const threadA = "env\u0000thread-a";
  const threadB = "env\u0000thread-b";

  it("closes one thread's card without touching another's", () => {
    const dismissed = dismissFloatingPreviewThread({}, threadA);
    expect(threadA in dismissed).toBe(true);
    expect(threadB in dismissed).toBe(false);
  });

  it("brings a card back only for the thread restored", () => {
    const both = dismissFloatingPreviewThread(dismissFloatingPreviewThread({}, threadA), threadB);
    expect(Object.keys(restoreFloatingPreviewThread(both, threadA))).toEqual([threadB]);
    // Restoring a thread that was never closed changes nothing.
    const none = {};
    expect(restoreFloatingPreviewThread(none, threadA)).toBe(none);
  });

  it("forgets the oldest closed threads past the cap, and refreshes one closed again", () => {
    let dismissed = {};
    for (let index = 0; index <= FLOATING_PREVIEW_MAX_DISMISSED_THREADS; index += 1) {
      dismissed = dismissFloatingPreviewThread(dismissed, `thread-${index}`);
    }
    expect(Object.keys(dismissed)).toHaveLength(FLOATING_PREVIEW_MAX_DISMISSED_THREADS);
    expect("thread-0" in dismissed).toBe(false);
    dismissed = dismissFloatingPreviewThread(dismissed, "thread-1");
    dismissed = dismissFloatingPreviewThread(dismissed, "thread-new");
    expect("thread-1" in dismissed).toBe(true);
    expect("thread-2" in dismissed).toBe(false);
  });
});

describe("floating preview labels", () => {
  it("titles the card by page title, then host", () => {
    expect(floatingPreviewTitle(page("https://example.com/a", "Docs"))).toBe("Docs");
    expect(floatingPreviewTitle(page("https://example.com/a"))).toBe("example.com");
  });
});

describe("floatingPreviewCardSize", () => {
  const roomy = { width: 2000, height: 1400 };
  const title = FLOATING_PREVIEW_TITLE_HEIGHT;

  it("starts at the default card: a 16:10 page area over the title strip", () => {
    expect(floatingPreviewCardSize(null, roomy, { bottom: 0 })).toEqual({
      width: FLOATING_PREVIEW_CARD_WIDTH,
      height: FLOATING_PREVIEW_CARD_HEIGHT + title,
    });
    expect(floatingPreviewCardSize(400, roomy, { bottom: 0 })).toEqual({
      width: 400,
      height: 250 + title,
    });
  });

  it("shapes the page area like the tab's viewport", () => {
    expect(floatingPreviewCardSize(400, roomy, { bottom: 0 }, 0.8)).toEqual({
      width: 400,
      height: 500 + title,
    });
  });

  it("clamps to the minimum and maximum width", () => {
    expect(floatingPreviewCardSize(10, roomy, { bottom: 0 }).width).toBe(
      FLOATING_PREVIEW_MIN_WIDTH,
    );
    expect(floatingPreviewCardSize(5000, roomy, { bottom: 0 }).width).toBe(
      FLOATING_PREVIEW_MAX_WIDTH,
    );
  });

  it("shrinks to fit a narrow or short pane, but never below the minimum", () => {
    // 60% of 600 px.
    expect(floatingPreviewCardSize(500, { width: 600, height: 1400 }, { bottom: 0 }).width).toBe(
      360,
    );
    // 400 - 150 composer - 24 margins - 28 title leaves 198 px of page: 316.8 px wide at 16:10.
    expect(floatingPreviewCardSize(500, { width: 2000, height: 400 }, { bottom: 150 }).width).toBe(
      317,
    );
    expect(floatingPreviewCardSize(500, { width: 100, height: 100 }, { bottom: 0 }).width).toBe(
      FLOATING_PREVIEW_MIN_WIDTH,
    );
  });

  it("needs more height to float a tall page", () => {
    expect(floatingPreviewMinCardSize().height).toBe(125 + title);
    expect(floatingPreviewMinCardSize(0.8).height).toBe(250 + title);
  });
});

describe("floating preview page scale", () => {
  const box = { width: 248, height: 155 };

  it("fits a whole 16:10 viewport exactly", () => {
    expect(floatingPreviewPageFrame({ width: 1280, height: 800 }, box)).toEqual({
      left: 0,
      top: 0,
      width: 248,
      height: 155,
      scale: 248 / 1280,
    });
  });

  it("scales a tall viewport by its height and centres it, instead of cropping to its top", () => {
    // A side-panel-shaped page: 700 x 1100.
    const frame = floatingPreviewPageFrame({ width: 700, height: 1100 }, box);
    expect(frame?.scale).toBeCloseTo(155 / 1100);
    expect(frame?.height).toBeCloseTo(155);
    expect(frame?.width).toBeCloseTo(700 * (155 / 1100));
    expect(frame?.left).toBeCloseTo((248 - 700 * (155 / 1100)) / 2);
    expect(frame?.top).toBe(0);
  });

  it("scales a wide viewport by its width and centres it", () => {
    const frame = floatingPreviewPageFrame({ width: 2000, height: 500 }, box);
    expect(frame?.scale).toBeCloseTo(248 / 2000);
    expect(frame?.width).toBeCloseTo(248);
    expect(frame?.top).toBeCloseTo((155 - 62) / 2);
  });

  it("depends only on the page's shape, so device pixels and CSS pixels agree", () => {
    const css = floatingPreviewPageFrame({ width: 900, height: 700 }, box);
    const retina = floatingPreviewPageFrame({ width: 1800, height: 1400 }, box);
    expect(retina?.width).toBeCloseTo(css?.width ?? 0);
    expect(retina?.height).toBeCloseTo(css?.height ?? 0);
    expect(retina?.left).toBeCloseTo(css?.left ?? 0);
  });

  it("recomputes for a resized card", () => {
    const page = { width: 1280, height: 800 };
    expect(floatingPreviewPageFrame(page, { width: 496, height: 310 })?.scale).toBeCloseTo(
      2 * (floatingPreviewPageFrame(page, box)?.scale ?? 0),
    );
  });

  it("draws nothing until both the page and the card have a size", () => {
    expect(floatingPreviewPageFrame(null, box)).toBeNull();
    expect(floatingPreviewPageFrame({ width: 0, height: 800 }, box)).toBeNull();
    expect(
      floatingPreviewPageFrame({ width: 1280, height: 800 }, { width: 0, height: 0 }),
    ).toBeNull();
  });

  it("bounds the page area's shape, letterboxing pages beyond it", () => {
    expect(floatingPreviewPageAspect(null)).toBe(DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT);
    expect(floatingPreviewPageAspect({ width: 1280, height: 800 })).toBe(1.6);
    expect(floatingPreviewPageAspect({ width: 400, height: 2000 })).toBe(
      FLOATING_PREVIEW_MIN_PAGE_ASPECT,
    );
    expect(floatingPreviewPageAspect({ width: 4000, height: 500 })).toBe(
      FLOATING_PREVIEW_MAX_PAGE_ASPECT,
    );
  });
});

describe("floating preview pane area", () => {
  it("keeps a free card inside the chat pane, above the composer and left of the minimap", () => {
    const area = floatingPreviewPaneArea({ width: 1000, height: 800 }, { bottom: 120, right: 24 });
    const card = { width: 248, height: 183 };
    expect(clampFloatingPreviewToArea({ x: -300, y: -50 }, area, card)).toEqual({ x: 12, y: 12 });
    expect(clampFloatingPreviewToArea({ x: 5000, y: 5000 }, area, card)).toEqual({
      x: 1000 - 24 - 12 - 248,
      y: 800 - 120 - 12 - 183,
    });
  });
});

describe("floating preview resizing", () => {
  const area = { left: 0, top: 0, right: 1000, bottom: 800 };
  const card = { width: 248, height: 155 };

  it("puts a docked card's grip across from its corner", () => {
    expect(oppositeFloatingPreviewCorner("top-right")).toBe("bottom-left");
    expect(oppositeFloatingPreviewCorner("bottom-left")).toBe("top-right");
  });

  it("puts a free card's grip on the corner facing the middle of the window", () => {
    expect(floatingPreviewResizeHandle({ x: 700, y: 50 }, card, area)).toBe("bottom-left");
    expect(floatingPreviewResizeHandle({ x: 20, y: 600 }, card, area)).toBe("top-right");
  });

  it("grows when the grip is pulled away from the card, led by the axis that moved most", () => {
    expect(resizeFloatingPreviewWidth(248, "bottom-right", { dx: 40, dy: 0 })).toBe(288);
    expect(resizeFloatingPreviewWidth(248, "bottom-left", { dx: -40, dy: 0 })).toBe(288);
    expect(resizeFloatingPreviewWidth(248, "bottom-left", { dx: 40, dy: 0 })).toBe(208);
    // 50 px down at 16:10 is 80 px of width, more than the 10 px across.
    expect(resizeFloatingPreviewWidth(248, "bottom-right", { dx: 10, dy: 50 })).toBe(328);
    expect(resizeFloatingPreviewWidth(248, "top-right", { dx: 0, dy: 50 })).toBe(168);
  });

  it("keeps the corner across from the grip in place", () => {
    const start = { position: { x: 500, y: 300 }, card };
    const bigger = { width: 348, height: 218 };
    expect(anchorResizedFloatingPreview(start, "bottom-right", bigger)).toEqual({ x: 500, y: 300 });
    expect(anchorResizedFloatingPreview(start, "top-left", bigger)).toEqual({ x: 400, y: 237 });
  });
});

describe("floating preview driver", () => {
  it("trusts a streamed tab's own control report over the session flag", () => {
    const input = { agentDriving: true, desktopController: null };
    expect(resolveFloatingPreviewDriver({ ...input, streamController: "agent" })).toBe("agent");
    expect(resolveFloatingPreviewDriver({ ...input, streamController: "another-viewer" })).toBe(
      "another-viewer",
    );
    expect(resolveFloatingPreviewDriver({ ...input, streamController: "unclaimed" })).toBe("none");
    expect(resolveFloatingPreviewDriver({ ...input, streamController: null })).toBe("agent");
  });

  it("reads a desktop tab's last input", () => {
    const input = { streamController: null, agentDriving: false };
    expect(resolveFloatingPreviewDriver({ ...input, desktopController: "agent" })).toBe("agent");
    expect(resolveFloatingPreviewDriver({ ...input, desktopController: "human" })).toBe("you");
    expect(resolveFloatingPreviewDriver({ ...input, desktopController: "none" })).toBe("none");
  });
});
