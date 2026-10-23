import type { PreviewNavStatus } from "@t3tools/contracts";

/** The streamed thumbnail asks for at most one frame per this interval. */
export const FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS = 1_000;
/** A desktop tab's thumbnail is recaptured this often while the card shows. */
export const FLOATING_PREVIEW_CAPTURE_INTERVAL_MS = 2_000;
/** The card's size in CSS px: the page fills it edge to edge at 16:10. */
export const FLOATING_PREVIEW_CARD_WIDTH = 248;
export const FLOATING_PREVIEW_CARD_HEIGHT = 155;
/** Space between the card and whatever edge or obstacle it docks against. */
const FLOATING_PREVIEW_MARGIN = 16;
/** A pane narrower than this keeps the chat to itself. */
export const FLOATING_PREVIEW_MIN_PANE_WIDTH = 560;
/** A press that moves less than this is a click, not a drag. */
export const FLOATING_PREVIEW_DRAG_SLOP_PX = 4;

const BLANK_PAGE_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/"]);

/** Whether a tab has been sent to a real page; a new or blank tab has nothing to show. */
export function previewTabHasPage(navStatus: PreviewNavStatus | null | undefined): boolean {
  if (!navStatus || navStatus._tag === "Idle") return false;
  const url = navStatus.url.trim().toLowerCase();
  return url !== "" && !url.startsWith("about:") && !BLANK_PAGE_URLS.has(url);
}

/** Identifies one tab across threads and environments. */
export function floatingPreviewTabKey(threadKey: string, tabId: string): string {
  return `${threadKey}\u0000${tabId}`;
}

/**
 * Whether the floating card shows for the tab a browser panel showed last.
 * It shows only while no panel shows that tab, the tab still has a page, and
 * the user has not dismissed it since they last looked at it.
 */
export function shouldShowFloatingPreview(input: {
  /** Key of the tab a browser panel showed last, if any. */
  readonly targetKey: string | null;
  /** Keys of tabs a browser panel shows right now. */
  readonly shownKeys: ReadonlySet<string>;
  readonly dismissedKey: string | null;
  /** The tab's session list arrived, so a missing tab really is closed. */
  readonly sessionsLoaded: boolean;
  /** The tab's current page; null when the session is gone. */
  readonly navStatus: PreviewNavStatus | null;
  /** This client can draw a thumbnail for the tab. */
  readonly thumbnailAvailable: boolean;
  /** The desktop's separate preview window already shows the tab. */
  readonly poppedOut: boolean;
  /** The pane is wide enough to float a card beside the chat. */
  readonly paneFits: boolean;
}): boolean {
  const { targetKey } = input;
  if (targetKey === null || input.poppedOut) return false;
  if (input.shownKeys.has(targetKey) || input.dismissedKey === targetKey) return false;
  if (!input.sessionsLoaded || !input.thumbnailAvailable || !input.paneFits) return false;
  return previewTabHasPage(input.navStatus);
}

export type FloatingPreviewCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface FloatingPreviewInsets {
  readonly top: number;
  /** Includes the docked composer, so bottom corners sit above it. */
  readonly bottom: number;
  /** Keeps right corners clear of the timeline minimap strip. */
  readonly right?: number;
}

export interface FloatingPreviewPoint {
  readonly x: number;
  readonly y: number;
}

export interface FloatingPreviewSize {
  readonly width: number;
  readonly height: number;
}

/** The card's top-left in pane coordinates when docked in `corner`. */
export function floatingPreviewCornerPosition(
  corner: FloatingPreviewCorner,
  pane: FloatingPreviewSize,
  card: FloatingPreviewSize,
  insets: FloatingPreviewInsets,
): FloatingPreviewPoint {
  const left = FLOATING_PREVIEW_MARGIN;
  const right = Math.max(
    left,
    pane.width - (insets.right ?? 0) - card.width - FLOATING_PREVIEW_MARGIN,
  );
  const top = insets.top + FLOATING_PREVIEW_MARGIN;
  // A short pane keeps the card under the top inset rather than behind the composer.
  const bottom = Math.max(top, pane.height - insets.bottom - card.height - FLOATING_PREVIEW_MARGIN);
  return {
    x: corner.endsWith("left") ? left : right,
    y: corner.startsWith("top") ? top : bottom,
  };
}

/** The corner a card dropped at `position` snaps to: whichever its center is nearest. */
export function nearestFloatingPreviewCorner(
  position: FloatingPreviewPoint,
  pane: FloatingPreviewSize,
  card: FloatingPreviewSize,
): FloatingPreviewCorner {
  const centerX = position.x + card.width / 2;
  const centerY = position.y + card.height / 2;
  const vertical = centerY < pane.height / 2 ? "top" : "bottom";
  const horizontal = centerX < pane.width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

/** A drop within this distance of a docked corner snaps to it; farther, the card stays put. */
export const FLOATING_PREVIEW_SNAP_DISTANCE = 56;

export interface FloatingPreviewArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Keeps a card fully inside an area, such as the window below its titlebar. */
export function clampFloatingPreviewToArea(
  position: FloatingPreviewPoint,
  area: FloatingPreviewArea,
  card: FloatingPreviewSize,
): FloatingPreviewPoint {
  return {
    x: Math.min(Math.max(area.left, position.x), Math.max(area.left, area.right - card.width)),
    y: Math.min(Math.max(area.top, position.y), Math.max(area.top, area.bottom - card.height)),
  };
}

/**
 * Where a dropped card rests: the nearest docked corner when the drop lands
 * close to it, otherwise exactly where it was dropped.
 */
export function resolveFloatingPreviewDrop(
  dropped: FloatingPreviewPoint,
  corners: Readonly<Record<FloatingPreviewCorner, FloatingPreviewPoint>>,
):
  | { readonly kind: "corner"; readonly corner: FloatingPreviewCorner }
  | { readonly kind: "free"; readonly position: FloatingPreviewPoint } {
  let nearest: FloatingPreviewCorner | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [corner, point] of Object.entries(corners) as Array<
    [FloatingPreviewCorner, FloatingPreviewPoint]
  >) {
    const distance = Math.hypot(point.x - dropped.x, point.y - dropped.y);
    if (distance < nearestDistance) {
      nearest = corner;
      nearestDistance = distance;
    }
  }
  return nearest !== null && nearestDistance <= FLOATING_PREVIEW_SNAP_DISTANCE
    ? { kind: "corner", corner: nearest }
    : { kind: "free", position: dropped };
}

/** Keeps a dragged card inside the pane. */
export function clampFloatingPreviewPosition(
  position: FloatingPreviewPoint,
  pane: FloatingPreviewSize,
  card: FloatingPreviewSize,
): FloatingPreviewPoint {
  return {
    x: Math.min(Math.max(0, position.x), Math.max(0, pane.width - card.width)),
    y: Math.min(Math.max(0, position.y), Math.max(0, pane.height - card.height)),
  };
}

/** The card's title: the page title, else its host, else the raw URL. */
export function floatingPreviewTitle(navStatus: PreviewNavStatus): string {
  if (navStatus._tag === "Idle") return "New tab";
  if (navStatus.title.trim().length > 0) return navStatus.title;
  if (!URL.canParse(navStatus.url)) return navStatus.url;
  return new URL(navStatus.url).host || navStatus.url;
}
