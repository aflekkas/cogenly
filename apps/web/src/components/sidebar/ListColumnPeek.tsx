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
 * The list column's hover peek (see listColumnPeek.logic). A store rather than
 * layout state, so hover changes re-render the rail and the column's frame,
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

// Hover only: touch keeps tapping the rail and the toggle.
function onPeekPointerEnter(event: ReactPointerEvent) {
  if (event.pointerType === "mouse") dispatchPeek({ type: "pointer-enter" });
}

function onPeekPointerLeave(event: ReactPointerEvent) {
  if (event.pointerType === "mouse") dispatchPeek({ type: "pointer-leave" });
}

/** Spread on the nav rail: hovering it floats the collapsed list column out. */
export const listColumnPeekRailHandlers = {
  onPointerEnter: onPeekPointerEnter,
  onPointerLeave: onPeekPointerLeave,
};

/** Spread on the list column's Sidebar, with `peek` from useListColumnPeekSurface. */
export const listColumnPeekPanelProps = {
  ref: (element: HTMLDivElement | null) => {
    peekPanel = element;
  },
  onPointerEnter: onPeekPointerEnter,
  onPointerLeave: onPeekPointerLeave,
  // A click or Enter that navigates (a thread, a new chat) closes the peek;
  // the route change arrives a moment later.
  onPointerDownCapture: () => {
    lastPanelActivationAt = performance.now();
  },
  onKeyDownCapture: (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") lastPanelActivationAt = performance.now();
  },
  onKeyDown: (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A menu portaled from the column takes its own Escape.
    if (!(event.target instanceof Node) || !peekPanel?.contains(event.target)) return;
    if (useListColumnPeekStore.getState().peek.phase !== "open") return;
    dismissPeek();
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

// Keyboard focus, a text field (the search), an open menu or popover from the
// column, or a context menu keep it open. Focus a mouse click leaves on a row
// does not: it would hold the peek after the pointer has gone.
function readPeekHold(): boolean {
  if (isContextMenuOpen()) return true;
  const panel = peekPanel;
  if (!panel) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && panel.contains(active) && active.matches(":focus-visible")) {
    return true;
  }
  return panel.querySelector("[data-popup-open]") !== null;
}

function syncPeekHold() {
  if (useListColumnPeekStore.getState().peek.phase !== "open") return;
  dispatchPeek({ type: "hold", held: readPeekHold() });
}

/** The `peek` prop for the list column's Sidebar. */
export function useListColumnPeekSurface() {
  return useListColumnPeekStore((store) =>
    store.available ? resolveListColumnPeekSurface(store.peek) : undefined,
  );
}

/** Whether the column is floating out right now (rail clicks then switch inside it). */
export function useListColumnPeekOpen() {
  return useListColumnPeekStore((store) => store.available && store.peek.phase === "open");
}

/** Runs the peek's timers and holds. Renders nothing. */
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
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [phase]);

  return null;
}
