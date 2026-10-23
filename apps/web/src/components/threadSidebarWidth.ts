export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 19 * 16;
// A list column, not a pane: about iMessage's width, growing a little on
// wide windows and never past 344px.
const THREAD_SIDEBAR_MAX_DEFAULT_WIDTH = 344;
const THREAD_SIDEBAR_VIEWPORT_SHARE = 0.22;

function proportionalThreadSidebarWidth(viewportWidth: number): number {
  return Math.min(
    THREAD_SIDEBAR_MAX_DEFAULT_WIDTH,
    Math.max(
      THREAD_SIDEBAR_DEFAULT_WIDTH,
      Math.round(viewportWidth * THREAD_SIDEBAR_VIEWPORT_SHARE),
    ),
  );
}
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
// The chat column's floor beside the list column and the right panel. Narrow
// columns get tight lane gutters (resolveChatLaneGutter), so this can sit at
// about a phone's width.
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 20 * 16;

// The brand's measured width can raise the minimum so "T3 Code" never clips.
export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

/**
 * The widest a drag may take the list column. Beside an open inline right
 * panel it stops where that panel would drop under its minimum (so a resize
 * never auto-collapses the column it just widened), but never under the
 * column's current width, so grabbing it does not snap it narrower.
 */
export function resolveThreadSidebarDragMaximumWidth(input: {
  /** The window width less the nav rail. */
  readonly availableWidth: number;
  readonly minimumWidth: number;
  readonly currentWidth: number;
  /** The open inline right panel's minimum width, or null when none is open. */
  readonly rightPanelMinimumWidth: number | null;
}): number {
  const maximumWidth = resolveThreadSidebarMaximumWidth(input.availableWidth, input.minimumWidth);
  if (input.rightPanelMinimumWidth === null) return maximumWidth;
  const besidePanel = resolveThreadSidebarMaximumWidth(
    input.availableWidth - input.rightPanelMinimumWidth,
    input.minimumWidth,
  );
  return Math.min(maximumWidth, Math.max(input.currentWidth, besidePanel));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? proportionalThreadSidebarWidth(viewportWidth)
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
