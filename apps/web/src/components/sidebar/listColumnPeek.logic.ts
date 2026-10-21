import { mainColumnCrampedBesidePanel } from "./listColumnLayoutStore";

/**
 * The list column's overlay: on a window too narrow to keep the column open
 * beside the main column, a deliberate action (a rail mode click, the sidebar
 * toggle or its shortcut) floats the collapsed column over the page. It closes
 * on a thread pick, Escape, a click outside, or the same rail icon again.
 * Pure state; ListColumnPeek.tsx owns the listeners and the DOM.
 */

/** How long the closing motion runs before the column drops its overlay styles (--motion-duration-base). */
export const LIST_COLUMN_PEEK_SETTLE_MS = 220;
/** A route change this soon after a click or Enter inside the column came from it. */
export const LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS = 1000;

export type ListColumnPeekPhase = "closed" | "open" | "closing";

export interface ListColumnPeekState {
  readonly phase: ListColumnPeekPhase;
  /** Something inside the column keeps it open against an outside click: the search field, a menu. */
  readonly held: boolean;
  /**
   * The step running: "open" paints the hidden state for a frame so the slide
   * has somewhere to start, "settle" lets the closing motion finish.
   */
  readonly pending: "open" | "settle" | null;
}

export type ListColumnPeekEvent =
  | { readonly type: "open" }
  /** The sidebar toggle or its shortcut. */
  | { readonly type: "toggle" }
  | { readonly type: "hold"; readonly held: boolean }
  /** A press outside the column, the rail and the toggle. */
  | { readonly type: "outside-press" }
  /** The pending step finished. */
  | { readonly type: "timer" }
  /** Closes at once: a thread was picked, Escape, or the same rail icon again. */
  | { readonly type: "dismiss" }
  | { readonly type: "reset" };

export const LIST_COLUMN_PEEK_IDLE: ListColumnPeekState = {
  phase: "closed",
  held: false,
  pending: null,
};

function dismiss(state: ListColumnPeekState): ListColumnPeekState {
  if (state.phase === "open") return { ...state, phase: "closing", pending: "settle" };
  // Not out yet: a pending open is dropped, a running close finishes.
  return state.pending === "open" ? { ...state, pending: null } : state;
}

export function reduceListColumnPeek(
  state: ListColumnPeekState,
  event: ListColumnPeekEvent,
): ListColumnPeekState {
  switch (event.type) {
    case "open":
      return state.phase === "open" || state.pending === "open"
        ? state
        : { ...state, pending: "open" };
    case "toggle":
      return state.phase === "open" || state.pending === "open"
        ? dismiss(state)
        : reduceListColumnPeek(state, { type: "open" });
    case "hold":
      return state.held === event.held ? state : { ...state, held: event.held };
    case "outside-press":
      return state.held ? state : dismiss(state);
    case "timer":
      switch (state.pending) {
        case "open":
          return { ...state, phase: "open", pending: null };
        case "settle":
          return { ...state, phase: "closed", pending: null };
        default:
          return state;
      }
    case "dismiss":
      return dismiss(state);
    case "reset":
      return state === LIST_COLUMN_PEEK_IDLE ? state : LIST_COLUMN_PEEK_IDLE;
  }
}

/**
 * What the column draws. "closed" carries the overlay's off-canvas styles (and its
 * transition) from the frame before it opens until the closing motion settles,
 * so the reduced-motion fade has a hidden state to start from. undefined is the
 * plain collapsed column, which the sidebar toggle animates on its own.
 */
export function resolveListColumnPeekSurface(
  state: ListColumnPeekState,
): "open" | "closed" | undefined {
  if (state.phase === "open") return "open";
  if (state.phase === "closing" || state.pending === "open") return "closed";
  return undefined;
}

/**
 * The overlay is offered only where the column is collapsed and opening it inline
 * would cramp the main column (the same measure that auto-collapses it beside
 * a right panel). Wide windows keep today's collapsed column.
 */
export function listColumnPeekAvailable(input: {
  readonly navRailVisible: boolean;
  readonly listColumnOpen: boolean;
  readonly listColumnHidden: boolean;
  readonly viewportWidth: number;
  readonly navRailWidth: number;
  readonly listColumnWidth: number;
  readonly rightPanelWidth: number | null;
}): boolean {
  if (!input.navRailVisible || input.listColumnOpen || input.listColumnHidden) return false;
  return mainColumnCrampedBesidePanel({
    viewportWidth: input.viewportWidth,
    navRailWidth: input.navRailWidth,
    listColumnWidth: input.listColumnWidth,
    rightPanelWidth: input.rightPanelWidth ?? 0,
  });
}

/** Whether a route change closes the overlay: it followed an activation inside the column. */
export function listColumnPeekDismissedByNavigation(
  lastActivationAt: number | null,
  now: number,
): boolean {
  return (
    lastActivationAt !== null && now - lastActivationAt <= LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS
  );
}
