/**
 * What a disclosure panel holds between renders: whether its content is in the
 * DOM, whether the first open should animate, and whether a height transition
 * is in flight. Kept pure so the open/close bookkeeping is testable without
 * the DOM.
 */
export interface DisclosurePanelState {
  /** Content is in the DOM, including while it animates closed. */
  readonly mounted: boolean;
  /** The open that is showing (or will show) animates from zero height. */
  readonly animateEnter: boolean;
  /** A height transition is running; the content clips meanwhile. */
  readonly moving: boolean;
  /** The `open` the state last reconciled against. */
  readonly open: boolean;
}

export function initialDisclosurePanelState(open: boolean, appear: boolean): DisclosurePanelState {
  return { mounted: open, animateEnter: appear, moving: appear && open, open };
}

/**
 * Reconciles the panel with a new `open`. An open mounts the content and, when
 * it was not already mounted, arms the enter animation. A close keeps the
 * content mounted until the exit settles. Returns the same state for no change.
 */
export function reconcileDisclosurePanel(
  state: DisclosurePanelState,
  open: boolean,
): DisclosurePanelState {
  if (state.open === open) return state;
  if (open) {
    return {
      open,
      moving: true,
      mounted: true,
      animateEnter: state.animateEnter || !state.mounted,
    };
  }
  return { ...state, open, moving: true };
}

/** The transition ended, or its fallback timer fired: a closed panel leaves the DOM. */
export function settleDisclosurePanel(state: DisclosurePanelState): DisclosurePanelState {
  if (!state.moving && (state.open || !state.mounted)) return state;
  return { ...state, moving: false, mounted: state.open ? state.mounted : false };
}

/**
 * Whether content renders at all. Under reduced motion nothing animates, so a
 * closed panel leaves at once instead of holding its content for an exit.
 */
export function disclosurePanelPresent(state: DisclosurePanelState, reducedMotion: boolean) {
  return state.mounted && !(reducedMotion && !state.open);
}

/**
 * Whether a closed panel reports its exit now: only once content it showed has
 * left the DOM. A panel that mounted closed never showed anything. A fold's
 * rows share one exit, so a row that scrolls into view while its fold closes
 * must not report it and drop the rows still animating out.
 */
export function disclosureExitDue(open: boolean, present: boolean, shown: boolean) {
  return !open && !present && shown;
}

/** Disclosures open on the base motion token and leave on the fast one. */
export function disclosureDuration(open: boolean) {
  return {
    transitionDuration: open ? "var(--motion-duration-base)" : "var(--motion-duration-fast)",
  };
}
