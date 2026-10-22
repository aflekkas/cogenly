/**
 * The list column's peek: while the column is collapsed, hovering the sidebar
 * toggle floats it out over the page as an overlay, for as long as the pointer
 * stays on the toggle or the overlay. Clicking the toggle docks the column
 * instead. Pure state; ListColumnPeek.tsx owns the timers and the DOM.
 */

/** Hover intent before the column floats out, so passing over the toggle does nothing. */
export const LIST_COLUMN_PEEK_OPEN_DELAY_MS = 120;
/** Grace after the pointer leaves, so crossing from the toggle to the overlay or overshooting doesn't flicker. */
export const LIST_COLUMN_PEEK_CLOSE_DELAY_MS = 250;
/**
 * How long the closing motion runs before the column drops its overlay styles:
 * the panel duration it opens and closes on (--motion-duration-panel,
 * PANEL_ANIMATION_DURATION in panelAnimations.ts).
 */
export const LIST_COLUMN_PEEK_SETTLE_MS = 270;
/** A route change this soon after a click or Enter inside the column came from it. */
export const LIST_COLUMN_PEEK_NAVIGATION_WINDOW_MS = 1000;

export type ListColumnPeekPhase = "closed" | "open" | "closing";

export interface ListColumnPeekState {
  readonly phase: ListColumnPeekPhase;
  /** The pointer is over the toggle or the overlay. */
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
  /** A press outside the overlay and the toggle. */
  | { readonly type: "outside-press" }
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

function dismiss(state: ListColumnPeekState): ListColumnPeekState {
  if (state.phase === "open") {
    return { ...state, phase: "closing", hovering: false, pending: "settle" };
  }
  return { ...state, hovering: false, pending: closeTimer(state) };
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
    case "outside-press":
      // A held overlay lets this press close its menu or leave its search first.
      return state.held ? state : dismiss(state);
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
    case "dismiss":
      return dismiss(state);
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
 * What the column draws. "closed" carries the overlay's off-canvas styles (and
 * its transition) from the start of hover intent until the closing motion
 * settles, so the slide and the reduced-motion fade have a hidden state to
 * start from. undefined is the plain collapsed column, which the sidebar
 * toggle animates on its own.
 */
export function resolveListColumnPeekSurface(
  state: ListColumnPeekState,
): "open" | "closed" | undefined {
  if (state.phase === "open") return "open";
  if (state.phase === "closing" || state.pending === "open") return "closed";
  return undefined;
}

/** The peek is offered wherever the rail's list column is collapsed, at any width. */
export function listColumnPeekAvailable(input: {
  readonly navRailVisible: boolean;
  readonly listColumnOpen: boolean;
  readonly listColumnHidden: boolean;
}): boolean {
  return input.navRailVisible && !input.listColumnOpen && !input.listColumnHidden;
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
