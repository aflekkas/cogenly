import { mainColumnCrampedBesidePanel } from "./listColumnLayoutStore";

/**
 * The list column's hover peek: on a window too narrow to keep the column
 * open beside the main column, hovering the nav rail floats the collapsed
 * column over the page for as long as the pointer stays on the rail or the
 * column. Pure state; ListColumnPeek.tsx owns the timers and the DOM.
 */

/** Hover intent before the column floats out, so passing over the rail does nothing. */
export const LIST_COLUMN_PEEK_OPEN_DELAY_MS = 120;
/** Grace after the pointer leaves, so crossing from rail to column or overshooting doesn't flicker. */
export const LIST_COLUMN_PEEK_CLOSE_DELAY_MS = 250;
/** How long the closing motion runs before the column drops its peek styles (--motion-duration-base). */
export const LIST_COLUMN_PEEK_SETTLE_MS = 220;
/** A route change this soon after a click or Enter inside the column came from it. */
export const LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS = 1000;

export type ListColumnPeekPhase = "closed" | "open" | "closing";

export interface ListColumnPeekState {
  readonly phase: ListColumnPeekPhase;
  /** The pointer is over the rail or the floating column. */
  readonly hovering: boolean;
  /** Something inside the column keeps it open: keyboard focus, the search field, a menu. */
  readonly held: boolean;
  /** The timer running: hover intent, leave grace, or the closing motion settling. */
  readonly pending: "open" | "close" | "settle" | null;
}

export type ListColumnPeekEvent =
  | { readonly type: "pointer-enter" }
  | { readonly type: "pointer-leave" }
  | { readonly type: "hold"; readonly held: boolean }
  /** The pending timer fired. */
  | { readonly type: "timer" }
  /** Closes at once: a thread was picked, or Escape. */
  | { readonly type: "dismiss" }
  | { readonly type: "reset" };

export const LIST_COLUMN_PEEK_IDLE: ListColumnPeekState = {
  phase: "closed",
  hovering: false,
  held: false,
  pending: null,
};

function closeTimer(state: ListColumnPeekState): ListColumnPeekState["pending"] {
  return state.phase === "closing" ? "settle" : null;
}

export function reduceListColumnPeek(
  state: ListColumnPeekState,
  event: ListColumnPeekEvent,
): ListColumnPeekState {
  switch (event.type) {
    case "pointer-enter": {
      if (state.phase === "open") {
        return {
          ...state,
          hovering: true,
          pending: state.pending === "close" ? null : state.pending,
        };
      }
      return { ...state, hovering: true, pending: "open" };
    }
    case "pointer-leave": {
      if (state.phase === "open") {
        return { ...state, hovering: false, pending: state.held ? null : "close" };
      }
      // Left before the intent delay ran out: nothing opens.
      return {
        ...state,
        hovering: false,
        pending: state.pending === "open" ? closeTimer(state) : state.pending,
      };
    }
    case "hold": {
      if (state.held === event.held) return state;
      if (state.phase !== "open") return { ...state, held: event.held };
      if (event.held) {
        return { ...state, held: true, pending: state.pending === "close" ? null : state.pending };
      }
      return { ...state, held: false, pending: state.hovering ? state.pending : "close" };
    }
    case "timer": {
      switch (state.pending) {
        case "open":
          return { ...state, phase: "open", pending: null };
        case "close":
          return { ...state, phase: "closing", pending: "settle" };
        case "settle":
          return { ...state, phase: "closed", pending: null };
        default:
          return state;
      }
    }
    case "dismiss": {
      if (state.phase === "open") {
        return { ...state, phase: "closing", hovering: false, pending: "settle" };
      }
      return { ...state, hovering: false, pending: closeTimer(state) };
    }
    case "reset":
      return state === LIST_COLUMN_PEEK_IDLE ? state : LIST_COLUMN_PEEK_IDLE;
  }
}

export function listColumnPeekDelayMs(pending: NonNullable<ListColumnPeekState["pending"]>) {
  switch (pending) {
    case "open":
      return LIST_COLUMN_PEEK_OPEN_DELAY_MS;
    case "close":
      return LIST_COLUMN_PEEK_CLOSE_DELAY_MS;
    case "settle":
      return LIST_COLUMN_PEEK_SETTLE_MS;
  }
}

/**
 * What the column draws. "closed" carries the peek's off-canvas styles (and its
 * transition) from the start of hover intent until the closing motion settles,
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
 * The peek is offered only where the column is collapsed and opening it inline
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

/** Whether a route change closes the peek: it followed an activation inside the column. */
export function listColumnPeekDismissedByNavigation(
  lastActivationAt: number | null,
  now: number,
): boolean {
  return (
    lastActivationAt !== null && now - lastActivationAt <= LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS
  );
}
