import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { create } from "zustand";

import { isContextMenuOpen, subscribeContextMenuOpen } from "../../contextMenuOpen";
import {
  LIST_COLUMN_PEEK_IDLE,
  listColumnPeekDelayMs,
  listColumnPeekDismissedByNavigation,
  reduceListColumnPeek,
  resolveListColumnPeekSurface,
  type ListColumnPeekEvent,
  type ListColumnPeekState,
} from "./listColumnPeek.logic";

/**
 * The list column's peek (see listColumnPeek.logic). A store rather than
 * layout state, so hover changes re-render the toggle and the column's frame,
 * not the thread list inside it.
 */
export const useListColumnPeekStore = create<{
  readonly available: boolean;
  readonly peek: ListColumnPeekState;
  readonly dispatch: (event: ListColumnPeekEvent) => void;
  readonly setAvailable: (available: boolean) => void;
}>((set) => ({
  available: false,
  peek: LIST_COLUMN_PEEK_IDLE,
  dispatch: (event) =>
    set((state) => {
      if (!state.available) return state;
      const peek = reduceListColumnPeek(state.peek, event);
      return peek === state.peek ? state : { peek };
    }),
  setAvailable: (available) =>
    set((state) =>
      state.available === available
        ? state
        : { available, peek: reduceListColumnPeek(state.peek, { type: "reset" }) },
    ),
}));

const dispatchPeek = (event: ListColumnPeekEvent) =>
  useListColumnPeekStore.getState().dispatch(event);

let peekPanel: HTMLDivElement | null = null;
let lastPanelActivationAt: number | null = null;
/** Set by the controller while docking beside the right panel would cramp the main column. */
let makeRoomToDock: (() => void) | null = null;

// Hover only: touch keeps tapping the toggle.
function onPeekPointerEnter(event: ReactPointerEvent) {
  if (event.pointerType === "mouse") dispatchPeek({ type: "pointer-enter" });
}

function onPeekPointerLeave(event: ReactPointerEvent) {
  if (event.pointerType === "mouse") dispatchPeek({ type: "pointer-leave" });
}

/** Spread on the sidebar toggle: hovering it floats the collapsed column out. */
export const listColumnPeekToggleHandlers = {
  onPointerEnter: onPeekPointerEnter,
  onPointerLeave: onPeekPointerLeave,
};

/**
 * The sidebar toggle's click and shortcut: docks the collapsed column inline,
 * closing the right panel first where the main column would be cramped
 * beside it, or collapses a docked one. A peek showing at the time becomes
 * the docked column in place: the layout drops the overlay styles in the
 * same commit that docks it, so the panel never slides back out in between.
 */
export function toggleListColumn(toggleSidebar: () => void) {
  if (useListColumnPeekStore.getState().available) makeRoomToDock?.();
  toggleSidebar();
}

/** Spread on the list column's Sidebar, with `peek` from useListColumnPeekSurface. */
export const listColumnPeekPanelProps = {
  ref: (element: HTMLDivElement | null) => {
    peekPanel = element;
  },
  onPointerEnter: onPeekPointerEnter,
  onPointerLeave: onPeekPointerLeave,
  // A click or Enter that navigates (a thread, a new chat) closes the overlay;
  // the route change arrives a moment later.
  onPointerDownCapture: () => {
    lastPanelActivationAt = performance.now();
  },
  onKeyDownCapture: (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") lastPanelActivationAt = performance.now();
  },
  onFocusCapture: () => syncPeekHold(),
  onBlurCapture: () => {
    // Focus lands on its next target after blur.
    window.setTimeout(syncPeekHold, 0);
  },
};

function dismissPeek() {
  lastPanelActivationAt = null;
  dispatchPeek({ type: "dismiss" });
  // Focus left in the hidden column would hold the next peek open.
  const active = document.activeElement;
  if (active instanceof HTMLElement && peekPanel?.contains(active)) active.blur();
}

function menuOpenFromPanel(): boolean {
  return isContextMenuOpen() || peekPanel?.querySelector("[data-popup-open]") != null;
}

// Keyboard focus, a text field (the search), or an open menu, popover or
// context menu from the column keep it open after the pointer leaves, and
// against an outside click (which closes the menu or leaves the field first).
// Focus a mouse click leaves on a row does not.
function readPeekHold(): boolean {
  if (menuOpenFromPanel()) return true;
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    peekPanel?.contains(active) === true &&
    active.matches(":focus-visible")
  );
}

function syncPeekHold() {
  if (useListColumnPeekStore.getState().peek.phase !== "open") return;
  dispatchPeek({ type: "hold", held: readPeekHold() });
}

// The sidebar toggles (the rail's, or the one after the macOS traffic lights)
// drive the peek themselves.
const PEEK_OWN_CONTROLS = '[data-sidebar="trigger"]';

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (peekPanel?.contains(target) || target.closest(PEEK_OWN_CONTROLS)) return;
  // Read now: this press is about to blur the search or close the menu.
  syncPeekHold();
  dispatchPeek({ type: "outside-press" });
}

// Captured, since the focused composer consumes Escape; an open menu or
// popover (from the column or elsewhere) takes it first. The toggle's own
// tooltip, up while the pointer rests on it, does not count.
function onDocumentKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;
  if (isContextMenuOpen()) return;
  if (document.querySelector(`[data-popup-open]:not(${PEEK_OWN_CONTROLS})`)) return;
  dismissPeek();
}

/** The `peek` prop for the list column's Sidebar. */
export function useListColumnPeekSurface() {
  return useListColumnPeekStore((store) =>
    store.available ? resolveListColumnPeekSurface(store.peek) : undefined,
  );
}

/** Runs the peek's timers, holds and outside-press listeners. Renders nothing. */
export function ListColumnPeekController({
  available,
  pathname,
  makeRoom,
}: {
  available: boolean;
  pathname: string;
  /** Closes the right panel; passed while docking beside it would cramp the main column. */
  makeRoom: (() => void) | null;
}) {
  const pending = useListColumnPeekStore((store) => store.peek.pending);
  const phase = useListColumnPeekStore((store) => store.peek.phase);

  useEffect(() => {
    makeRoomToDock = makeRoom;
    return () => {
      makeRoomToDock = null;
    };
  }, [makeRoom]);

  useEffect(() => {
    useListColumnPeekStore.getState().setAvailable(available);
  }, [available]);

  useEffect(() => {
    if (pending === null) return;
    const timeout = window.setTimeout(
      () => dispatchPeek({ type: "timer" }),
      listColumnPeekDelayMs(pending),
    );
    return () => window.clearTimeout(timeout);
  }, [pending]);

  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    if (useListColumnPeekStore.getState().peek.phase !== "open") return;
    if (listColumnPeekDismissedByNavigation(lastPanelActivationAt, performance.now())) {
      dismissPeek();
    }
  }, [pathname]);

  useEffect(() => {
    if (phase !== "open") return;
    syncPeekHold();
    const panel = peekPanel;
    const observer = new MutationObserver(syncPeekHold);
    if (panel) {
      observer.observe(panel, {
        attributes: true,
        attributeFilter: ["data-popup-open"],
        subtree: true,
      });
    }
    const unsubscribe = subscribeContextMenuOpen(syncPeekHold);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    window.addEventListener("keydown", onDocumentKeyDown, true);
    return () => {
      observer.disconnect();
      unsubscribe();
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      window.removeEventListener("keydown", onDocumentKeyDown, true);
    };
  }, [phase]);

  return null;
}
