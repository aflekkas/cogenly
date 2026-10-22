import type { PreviewNavStatus } from "@t3tools/contracts";

/**
 * How long a floating tab may wait for its first frame with a spinner before
 * the card gives up and fades out. A frame that arrives later still shows it.
 */
export const PREVIEW_MINI_PLAYER_FIRST_PAINT_TIMEOUT_MS = 8_000;

const BLANK_PAGE_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/"]);

/**
 * Whether a tab has been sent to a real page. A new tab (Idle, no URL) or a
 * blank page has nothing worth floating.
 */
export function previewTabHasPage(navStatus: PreviewNavStatus | null | undefined): boolean {
  if (!navStatus || navStatus._tag === "Idle") return false;
  const url = navStatus.url.trim().toLowerCase();
  return url !== "" && !url.startsWith("about:") && !BLANK_PAGE_URLS.has(url);
}

/**
 * - `shown`: the card is up with the page in it.
 * - `loading`: the card is up with a spinner, only while an agent drives a
 *   tab that has not painted yet, and only until the wait runs out.
 * - `hidden`: the card stays mounted but transparent, so a page that paints
 *   later can still fade it in.
 */
export type PreviewMiniPlayerPresence = "shown" | "loading" | "hidden";

export function resolvePreviewMiniPlayerPresence(input: {
  /** The tab is on a real page (see `previewTabHasPage`). */
  readonly hasPage: boolean;
  /** The page has drawn into the card: a streamed frame, or a committed desktop webview. */
  readonly painted: boolean;
  /** An agent is driving the tab right now. */
  readonly agentDriving: boolean;
  /** The first-paint wait ran out. */
  readonly waitExpired: boolean;
}): PreviewMiniPlayerPresence {
  if (input.hasPage && input.painted) return "shown";
  if (input.agentDriving && !input.waitExpired) return "loading";
  return "hidden";
}
