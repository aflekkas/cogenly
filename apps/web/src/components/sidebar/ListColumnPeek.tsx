import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { create } from "zustand";

import { isContextMenuOpen, subscribeContextMenuOpen } from "../../contextMenuOpen";
import {
  LIST_COLUMN_PEEK_IDLE,
  LIST_COLUMN_PEEK_SETTLE_MS,
  listColumnPeekDismissedByNavigation,
  reduceListColumnPeek,
  resolveListColumnPeekSurface,
  type ListColumnPeekEvent,
  type ListColumnPeekState,
} from "./listColumnPeek.logic";

/**
 * The list column's overlay (see listColumnPeek.logic). A store rather than
 * layout state, so opening it re-renders the rail and the column's frame, not
 * the thread list inside it.
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

/**
 * The sidebar toggle and its shortcut: on a narrow window they float the
 * collapsed column out (or back), elsewhere they toggle it inline.
 */
export function toggleListColumn(toggleSidebar: () => void) {
  if (useListColumnPeekStore.getState().available) dispatchPeek({ type: "toggle" });
  else toggleSidebar();
}

/**
 * A rail click that shows the list column (a mode, Settings). On a narrow
 * window it floats the column out, and the icon already showing closes it
 * again. Returns false where the overlay is not offered.
 */
export function showListColumnFromRail(current: boolean): boolean {
  const { available, peek } = useListColumnPeekStore.getState();
  if (!available) return false;
  dispatchPeek(current && peek.phase === "open" ? { type: "dismiss" } : { type: "open" });
  return true;
}

/** Spread on the list column's Sidebar, with `peek` from useListColumnPeekSurface. */
export const listColumnPeekPanelProps = {
  ref: (element: HTMLDivElement | null) => {
    peekPanel = element;
  },
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
  // Focus left in the hidden column would land keystrokes in it.
  const active = document.activeElement;
  if (active instanceof HTMLElement && peekPanel?.contains(active)) active.blur();
}

function menuOpenFromPanel(): boolean {
  return isContextMenuOpen() || peekPanel?.querySelector("[data-popup-open]") != null;
}

// A text field (the search) or an open menu, popover or context menu from the
// column keeps it open against an outside click; that click closes the menu
// or leaves the field first. Focus a mouse click leaves on a row does not.
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

// The rail and the sidebar toggle drive the overlay themselves.
const PEEK_OWN_CONTROLS = "nav[data-nav-rail], [data-sidebar-control]";

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (peekPanel?.contains(target) || target.closest(PEEK_OWN_CONTROLS)) return;
  // Read now: this press is about to blur the search or close the menu.
  syncPeekHold();
  dispatchPeek({ type: "outside-press" });
}

function onDocumentKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  // A menu from the column takes its own Escape first.
  if (menuOpenFromPanel()) return;
  dismissPeek();
}

/** The `peek` prop for the list column's Sidebar. */
export function useListColumnPeekSurface() {
  return useListColumnPeekStore((store) =>
    store.available ? resolveListColumnPeekSurface(store.peek) : undefined,
  );
}

/** Whether the column is floating out right now. */
export function useListColumnPeekOpen() {
  return useListColumnPeekStore((store) => store.available && store.peek.phase === "open");
}

/** Runs the overlay's motion steps, holds and outside-press listeners. Renders nothing. */
export function ListColumnPeekController({
  available,
  pathname,
}: {
  available: boolean;
  pathname: string;
}) {
  const pending = useListColumnPeekStore((store) => store.peek.pending);
  const phase = useListColumnPeekStore((store) => store.peek.phase);

  useEffect(() => {
    useListColumnPeekStore.getState().setAvailable(available);
  }, [available]);

  useEffect(() => {
    if (pending === null) return;
    if (pending === "settle") {
      const timeout = window.setTimeout(
        () => dispatchPeek({ type: "timer" }),
        LIST_COLUMN_PEEK_SETTLE_MS,
      );
      return () => window.clearTimeout(timeout);
    }
    // Opening: one painted frame of the hidden state, then the slide.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => dispatchPeek({ type: "timer" }));
    });
    return () => window.cancelAnimationFrame(frame);
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
    window.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      observer.disconnect();
      unsubscribe();
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      window.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [phase]);

  return null;
}
