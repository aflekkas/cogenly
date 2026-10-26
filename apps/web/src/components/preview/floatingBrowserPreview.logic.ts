import type { PreviewNavStatus } from "@cogenly/contracts";

/** The streamed thumbnail asks for at most one frame per this interval. */
export const FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS = 1_000;
/** A desktop tab's thumbnail is recaptured this often while the card shows. */
export const FLOATING_PREVIEW_CAPTURE_INTERVAL_MS = 2_000;
/** The card's size in CSS px: the page fills it edge to edge at 16:10. */
export const FLOATING_PREVIEW_CARD_WIDTH = 248;
export const FLOATING_PREVIEW_CARD_HEIGHT = 155;
/**
 * Space between the card and whatever edge or obstacle it docks against. Matches
 * the docked details card's inset from the canvas (right-3, top-3).
 */
const FLOATING_PREVIEW_MARGIN = 12;
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

/** At most this many threads remember a dismissed card; the oldest is forgotten first. */
export const FLOATING_PREVIEW_MAX_DISMISSED_THREADS = 200;

/** Threads whose card the user closed, by thread key, oldest first. */
export type FloatingPreviewDismissals = Readonly<Record<string, true>>;

/** Marks a thread's card closed until the user asks for it back. */
export function dismissFloatingPreviewThread(
  dismissed: FloatingPreviewDismissals,
  threadKey: string,
): FloatingPreviewDismissals {
  const { [threadKey]: _previous, ...rest } = dismissed;
  const keys = [...Object.keys(rest), threadKey].slice(-FLOATING_PREVIEW_MAX_DISMISSED_THREADS);
  return Object.fromEntries(keys.map((key) => [key, true as const]));
}

/** Lets a thread's card float again. */
export function restoreFloatingPreviewThread(
  dismissed: FloatingPreviewDismissals,
  threadKey: string,
): FloatingPreviewDismissals {
  if (!(threadKey in dismissed)) return dismissed;
  const { [threadKey]: _restored, ...rest } = dismissed;
  return rest;
}

/**
 * Whether the floating card shows for the tab a browser panel showed last.
 * It shows only while no panel shows that tab, the tab still has a page, and
 * the user has not closed the thread's card.
 */
export function shouldShowFloatingPreview(input: {
  /** Key of the tab a browser panel showed last, if any. */
  readonly targetKey: string | null;
  /** Keys of tabs a browser panel shows right now. */
  readonly shownKeys: ReadonlySet<string>;
  /** The user closed this thread's card and has not asked for it back. */
  readonly dismissed: boolean;
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
  if (input.shownKeys.has(targetKey) || input.dismissed) return false;
  if (!input.sessionsLoaded || !input.thumbnailAvailable || !input.paneFits) return false;
  return previewTabHasPage(input.navStatus);
}

export type FloatingPreviewCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Where the card rests until the user positions it: under the header, at the canvas's right edge. */
export const DEFAULT_FLOATING_PREVIEW_CORNER: FloatingPreviewCorner = "top-right";

interface FloatingPreviewInsets {
  readonly top: number;
  /** Includes the docked composer, so every corner sits above it. */
  readonly bottom: number;
  /** Keeps right corners clear of the timeline minimap strip. */
  readonly right?: number;
  /** The docked details card, in pane coordinates; right corners step left of it. */
  readonly detailsCard?: { readonly left: number; readonly bottom: number } | null;
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
  const rightEdge = Math.max(
    left,
    pane.width - (insets.right ?? 0) - card.width - FLOATING_PREVIEW_MARGIN,
  );
  const top = insets.top + FLOATING_PREVIEW_MARGIN;
  // Above the composer; a pane too short for that keeps the card under the top
  // inset, and floatingPreviewPaneFits hides it instead.
  const bottom = Math.max(top, pane.height - insets.bottom - card.height - FLOATING_PREVIEW_MARGIN);
  const y = corner.startsWith("top") ? top : bottom;
  // An open details card holds the top-right; a right corner beside it slides
  // left of it instead of covering it.
  const details = insets.detailsCard;
  const x = corner.endsWith("left")
    ? left
    : details && y < details.bottom + FLOATING_PREVIEW_MARGIN
      ? Math.max(left, Math.min(rightEdge, details.left - FLOATING_PREVIEW_MARGIN - card.width))
      : rightEdge;
  return { x, y };
}

/** Whether the chat pane has room to float a card without covering the composer. */
export function floatingPreviewPaneFits(
  pane: FloatingPreviewSize,
  card: FloatingPreviewSize,
  bottomInset: number,
): boolean {
  return (
    pane.width >= FLOATING_PREVIEW_MIN_PANE_WIDTH &&
    pane.height >= card.height + FLOATING_PREVIEW_MARGIN * 2 + bottomInset
  );
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

export interface PersistedFloatingPreview {
  readonly corner: FloatingPreviewCorner | null;
  readonly freePosition: FloatingPreviewPoint | null;
  readonly width: number | null;
  readonly dismissedThreads: FloatingPreviewDismissals;
}

/**
 * Version 1 always stored a corner, "bottom-right" until the card was moved, so
 * that corner with no free position is indistinguishable from the old default.
 * It resets to the new default; every other saved corner is one the user chose.
 * Before version 3 a free position was in window coordinates; it is now in the
 * chat pane's, so an old one is dropped and the card docks to its corner.
 */
export function migratePersistedFloatingPreview(
  persisted: unknown,
  version: number,
): PersistedFloatingPreview {
  const saved = (persisted ?? {}) as Partial<PersistedFloatingPreview>;
  const freePosition = version < 3 ? null : (saved.freePosition ?? null);
  const wasDefault = version < 2 && saved.freePosition == null && saved.corner === "bottom-right";
  return {
    corner: wasDefault ? null : (saved.corner ?? null),
    freePosition,
    width: typeof saved.width === "number" ? saved.width : null,
    dismissedThreads: saved.dismissedThreads ?? {},
  };
}

/** A drop within this distance of a docked corner snaps to it; farther, the card stays put. */
export const FLOATING_PREVIEW_SNAP_DISTANCE = 56;

export interface FloatingPreviewArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where a card may rest in the chat pane, in pane coordinates: inset like its
 * docked corners, above the composer and left of the minimap strip.
 */
export function floatingPreviewPaneArea(
  pane: FloatingPreviewSize,
  insets: { readonly bottom: number; readonly right?: number },
): FloatingPreviewArea {
  return {
    left: FLOATING_PREVIEW_MARGIN,
    top: FLOATING_PREVIEW_MARGIN,
    right: pane.width - (insets.right ?? 0) - FLOATING_PREVIEW_MARGIN,
    bottom: pane.height - insets.bottom - FLOATING_PREVIEW_MARGIN,
  };
}

/** Keeps a card fully inside an area, such as the chat pane's resting area. */
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
  return floatingPreviewHost(navStatus);
}

function floatingPreviewHost(navStatus: PreviewNavStatus): string {
  if (navStatus._tag === "Idle") return "a new tab";
  if (!URL.canParse(navStatus.url)) return navStatus.url;
  return new URL(navStatus.url).host || navStatus.url;
}

/** The solid title strip under the page, in CSS px. */
export const FLOATING_PREVIEW_TITLE_HEIGHT = 28;
/** The page area's width over height until the tab reports its viewport: 16:10. */
export const DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT =
  FLOATING_PREVIEW_CARD_WIDTH / FLOATING_PREVIEW_CARD_HEIGHT;
/**
 * The page area follows the tab's viewport shape within these bounds; a page
 * taller or wider still is letterboxed inside them rather than cropped.
 */
export const FLOATING_PREVIEW_MIN_PAGE_ASPECT = 0.75;
export const FLOATING_PREVIEW_MAX_PAGE_ASPECT = 2;
export const FLOATING_PREVIEW_MIN_WIDTH = 200;
export const FLOATING_PREVIEW_MAX_WIDTH = 560;
/** One arrow-key press on the resize handle. */
export const FLOATING_PREVIEW_RESIZE_STEP_PX = 24;
/** A resized card never takes more than this share of the pane's width. */
const FLOATING_PREVIEW_MAX_PANE_SHARE = 0.6;

/** The page area's shape for a tab's viewport: its own, kept within the card's bounds. */
export function floatingPreviewPageAspect(viewport: FloatingPreviewSize | null): number {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT;
  }
  return Math.min(
    FLOATING_PREVIEW_MAX_PAGE_ASPECT,
    Math.max(FLOATING_PREVIEW_MIN_PAGE_ASPECT, viewport.width / viewport.height),
  );
}

/** The smallest card for a page shape, which the pane must fit to float it. */
export function floatingPreviewMinCardSize(
  pageAspect: number = DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT,
): FloatingPreviewSize {
  return {
    width: FLOATING_PREVIEW_MIN_WIDTH,
    height: Math.round(FLOATING_PREVIEW_MIN_WIDTH / pageAspect) + FLOATING_PREVIEW_TITLE_HEIGHT,
  };
}

/**
 * The card's size for the width the user chose (null: the default), shrunk to
 * fit the pane it floats over: the page area in the page's shape, then the
 * title strip. The stored width stays as chosen, so a pane that grows again
 * gets the chosen size back.
 */
export function floatingPreviewCardSize(
  preferredWidth: number | null,
  pane: FloatingPreviewSize,
  insets: { readonly bottom: number; readonly right?: number },
  pageAspect: number = DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT,
): FloatingPreviewSize {
  const roomWidth = (pane.width - (insets.right ?? 0)) * FLOATING_PREVIEW_MAX_PANE_SHARE;
  const roomHeight =
    pane.height - insets.bottom - FLOATING_PREVIEW_MARGIN * 2 - FLOATING_PREVIEW_TITLE_HEIGHT;
  const maxWidth = Math.max(
    FLOATING_PREVIEW_MIN_WIDTH,
    Math.min(FLOATING_PREVIEW_MAX_WIDTH, roomWidth, roomHeight * pageAspect),
  );
  const preferred = preferredWidth ?? FLOATING_PREVIEW_CARD_WIDTH;
  const width = Math.round(Math.min(maxWidth, Math.max(FLOATING_PREVIEW_MIN_WIDTH, preferred)));
  return { width, height: Math.round(width / pageAspect) + FLOATING_PREVIEW_TITLE_HEIGHT };
}

export interface FloatingPreviewPageFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Box px per page px. */
  readonly scale: number;
}

/**
 * Where a page draws in the card's page area: its whole viewport, scaled down
 * (or up) to fit and centred, never cropped. `page` is whatever size the frame
 * or viewport is reported in; only its shape and the box decide the result.
 * Null until both have a size, so nothing draws at a guessed scale.
 */
export function floatingPreviewPageFrame(
  page: FloatingPreviewSize | null,
  box: FloatingPreviewSize,
): FloatingPreviewPageFrame | null {
  if (!page || page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height, scale };
}

/**
 * The corner the resize grip sits in: the one facing the middle of the area,
 * so the card grows into open space and the corner it rests against stays put.
 */
export function floatingPreviewResizeHandle(
  position: FloatingPreviewPoint,
  card: FloatingPreviewSize,
  area: FloatingPreviewArea,
): FloatingPreviewCorner {
  const centerX = position.x + card.width / 2;
  const centerY = position.y + card.height / 2;
  const vertical = centerY < (area.top + area.bottom) / 2 ? "bottom" : "top";
  const horizontal = centerX < (area.left + area.right) / 2 ? "right" : "left";
  return `${vertical}-${horizontal}`;
}

/** A docked card's grip sits across from the corner it rests in. */
export function oppositeFloatingPreviewCorner(
  corner: FloatingPreviewCorner,
): FloatingPreviewCorner {
  const vertical = corner.startsWith("top") ? "bottom" : "top";
  const horizontal = corner.endsWith("left") ? "right" : "left";
  return `${vertical}-${horizontal}`;
}

/**
 * The width a grip drag asks for. Pulling the grip away from the card grows it;
 * whichever axis moved further leads, so a diagonal drag tracks the pointer.
 */
export function resizeFloatingPreviewWidth(
  startWidth: number,
  handle: FloatingPreviewCorner,
  delta: { readonly dx: number; readonly dy: number },
  pageAspect: number = DEFAULT_FLOATING_PREVIEW_PAGE_ASPECT,
): number {
  const fromX = (handle.endsWith("right") ? 1 : -1) * delta.dx;
  const fromY = (handle.startsWith("bottom") ? 1 : -1) * delta.dy * pageAspect;
  return startWidth + (Math.abs(fromX) >= Math.abs(fromY) ? fromX : fromY);
}

/** Where a resized card sits so the corner opposite its grip does not move. */
export function anchorResizedFloatingPreview(
  start: { readonly position: FloatingPreviewPoint; readonly card: FloatingPreviewSize },
  handle: FloatingPreviewCorner,
  card: FloatingPreviewSize,
): FloatingPreviewPoint {
  const { position } = start;
  return {
    x: handle.endsWith("left") ? position.x + start.card.width - card.width : position.x,
    y: handle.startsWith("top") ? position.y + start.card.height - card.height : position.y,
  };
}

/** Who drives the floated tab, as this client can tell. */
export type FloatingPreviewDriver = "agent" | "you" | "another-viewer" | "none";

/**
 * A streamed tab's own control report wins when the card has one; otherwise
 * the session's agent flag, or a desktop tab's last input, decides.
 */
export function resolveFloatingPreviewDriver(input: {
  /** From the card's watch-only stream; null for desktop tabs or before it connects. */
  readonly streamController: "agent" | "you" | "another-viewer" | "unclaimed" | null;
  readonly agentDriving: boolean;
  readonly desktopController: "human" | "agent" | "none" | null;
}): FloatingPreviewDriver {
  switch (input.streamController) {
    case "agent":
      return "agent";
    case "you":
      return "you";
    case "another-viewer":
      return "another-viewer";
    case "unclaimed":
      return "none";
    case null:
      break;
  }
  if (input.desktopController === "human") return "you";
  if (input.agentDriving || input.desktopController === "agent") return "agent";
  return "none";
}
