import type { ReactNode } from "react";
import { useCallback, useId, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

/**
 * The page title sits in one place: the titlebar row right after the toggle
 * and back/forward pair. With the nav rail, that pair is fixed in the window
 * and the slot (`PageTitleSlot`) is fixed right after it, so the page's
 * leading title is portaled there and never moves or remounts as the list
 * column opens and closes. Without the rail (narrow windows, the legacy
 * sidebar) it stays in the page's own top bar.
 */
interface PageTitleSlotState {
  readonly slot: HTMLElement | null;
  /** The fixed titlebar slot is in use (the nav rail shows). */
  readonly docked: boolean;
  /**
   * Titles of pages on screen, latest last. Kept-alive pages (`<Activity
   * mode="hidden">`) drop out, as their effects unmount while hidden, and a
   * portal would otherwise escape the Activity's hiding.
   */
  readonly claims: ReadonlyArray<string>;
  setSlot: (slot: HTMLElement | null) => void;
  setDocked: (docked: boolean) => void;
  claim: (id: string) => void;
  release: (id: string) => void;
}

export const usePageTitleSlotStore = create<PageTitleSlotState>()((set) => ({
  slot: null,
  docked: false,
  claims: [],
  setSlot: (slot) => set({ slot }),
  setDocked: (docked) => set({ docked }),
  claim: (id) => set((state) => ({ claims: [...state.claims.filter((c) => c !== id), id] })),
  release: (id) => set((state) => ({ claims: state.claims.filter((c) => c !== id) })),
}));

/** The titlebar's title spot after the back/forward pair, filled by the page's `WorkspacePageTitle`. */
export function PageTitleSlot(props: { readonly className?: string }) {
  const setSlot = usePageTitleSlotStore((store) => store.setSlot);
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      setSlot(element);
    },
    [setSlot],
  );
  return <div ref={ref} className={props.className} />;
}

/** Wraps a page's leading title, rendering it in the list column header while that shows. */
export function WorkspacePageTitle(props: { readonly children: ReactNode }) {
  const id = useId();
  const slot = usePageTitleSlotStore((store) =>
    store.docked && store.claims.at(-1) === id ? store.slot : null,
  );
  useLayoutEffect(() => {
    const { claim, release } = usePageTitleSlotStore.getState();
    claim(id);
    return () => release(id);
  }, [id]);
  return slot ? createPortal(props.children, slot) : props.children;
}
