import { SIDEBAR_MODES, type SidebarMode } from "./sidebarModes.logic";

/**
 * The one enter motion of a sidebar mode switch: the list column and the main
 * pane fade in, rising from below when the picked mode sits lower on the rail
 * and settling from above when it sits higher. Opacity only under reduced
 * motion (see the utilities in index.css).
 *
 * The list column plays it as soon as the mode changes. The main pane plays it
 * once, when its content for the new mode first commits (often a navigation
 * later), so the motion never runs over the outgoing content.
 */
export type ModeSwitchDirection = "from-below" | "from-above";

const ENTER_CLASS: Record<ModeSwitchDirection, string> = {
  "from-below": "animate-mode-enter-from-below",
  "from-above": "animate-mode-enter-from-above",
};
/** The main pane's content for a picked mode lands within this long, or not at all. */
const PENDING_MAIN_ENTER_MS = 1000;

let pendingMainEnter: { direction: ModeSwitchDirection; expiresAt: number } | null = null;

export function modeSwitchDirection(
  previous: SidebarMode,
  next: SidebarMode,
): ModeSwitchDirection | null {
  if (previous === next) return null;
  return SIDEBAR_MODES.indexOf(next) > SIDEBAR_MODES.indexOf(previous)
    ? "from-below"
    : "from-above";
}

/** A hand-picked mode switch: the main pane's next content plays the enter motion. */
export function noteModeSwitchForMainPane(previous: SidebarMode, next: SidebarMode): void {
  const direction = modeSwitchDirection(previous, next);
  if (direction === null) return;
  pendingMainEnter = { direction, expiresAt: performance.now() + PENDING_MAIN_ENTER_MS };
}

/**
 * Plays the pending main pane motion on the contents of `pane` (a
 * SidebarInset), once. The pane's own opaque background stays put, so the
 * fade never shows the window backdrop. Call before paint.
 */
export function playPendingMainPaneEnter(pane: Element | null): void {
  const pending = pendingMainEnter;
  if (pending === null || pane === null) return;
  pendingMainEnter = null;
  if (performance.now() > pending.expiresAt) return;
  for (const child of pane.children) playModeEnter(child, pending.direction);
}

/** Drops a running enter motion, e.g. from a column about to be hidden. */
export function clearModeEnter(element: Element): void {
  element.classList.remove(ENTER_CLASS["from-below"], ENTER_CLASS["from-above"]);
}

/** Restarts the enter motion on `element`. Call before paint. */
export function playModeEnter(element: Element, direction: ModeSwitchDirection): void {
  clearModeEnter(element);
  // Restart the animation when the class was already there.
  void (element as HTMLElement).offsetWidth;
  const className = ENTER_CLASS[direction];
  element.classList.add(className);
  const onEnd = (event: Event) => {
    // Ignore the animations of descendants, which bubble here.
    if (event.target !== element) return;
    element.classList.remove(className);
    element.removeEventListener("animationend", onEnd);
    element.removeEventListener("animationcancel", onEnd);
  };
  element.addEventListener("animationend", onEnd);
  element.addEventListener("animationcancel", onEnd);
}
