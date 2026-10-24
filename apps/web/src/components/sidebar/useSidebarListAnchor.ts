import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";

import { restoredScrollTop } from "./sidebarListAnchor.logic";

/** Each list's scroll position, kept while the sidebar unmounts on Settings. */
const scrollTopByList = new Map<string, number>();

const viewportOf = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

/** The list and box each viewport was last held for. */
const heldByViewport = new WeakMap<
  HTMLElement,
  { readonly listKey: string; readonly scrollHeight: number; readonly clientHeight: number }
>();

/**
 * Puts `viewport` back at `listKey`'s remembered position (its first rows, for
 * a new list), when the list changed or its rows or viewport resized. Left
 * alone otherwise, so a render mid-scroll never tugs against the user.
 */
function holdScroll(viewport: HTMLElement, listKey: string) {
  const { scrollHeight, clientHeight } = viewport;
  const held = heldByViewport.get(viewport);
  heldByViewport.set(viewport, { listKey, scrollHeight, clientHeight });
  if (
    held?.listKey === listKey &&
    held.scrollHeight === scrollHeight &&
    held.clientHeight === clientHeight
  ) {
    return;
  }
  const next = restoredScrollTop(scrollTopByList.get(listKey), viewport);
  if (Math.abs(viewport.scrollTop - next) >= 1) viewport.scrollTop = next;
}

/**
 * Keeps each sidebar list's place. Lists read down from the search dock: one
 * never seen before opens on its first rows, and switching back to a list
 * lands where it was left, held there while its rows change so a render never
 * moves what is on screen.
 *
 * `listKey` names the list (a mode and its filter, or search). `anchorRef` is
 * the element holding the list's rows, inside the scroll viewport.
 *
 * Call it before any layout effect that measures rows (the list motion): it
 * settles the scroll in the same commit, so they measure where rows will paint.
 */
export function useSidebarListAnchor(anchorRef: RefObject<HTMLElement | null>, listKey: string) {
  const currentKey = useRef(listKey);
  currentKey.current = listKey;
  // Every commit, before paint: the rows this render drew hold their place,
  // and a list switched to lands at its own position.
  useLayoutEffect(() => {
    const viewport = viewportOf(anchorRef.current);
    if (viewport !== null) holdScroll(viewport, listKey);
  });
  useEffect(() => {
    const content = anchorRef.current;
    const viewport = viewportOf(content);
    if (content === null || viewport === null) return;
    const record = () => scrollTopByList.set(currentKey.current, viewport.scrollTop);
    // Rows that change outside a render here (another list component's own
    // updates, images, folds settling) or a resized viewport hold the same way.
    const hold = () => holdScroll(viewport, currentKey.current);
    viewport.addEventListener("scroll", record, { passive: true });
    const stopObserving = observeResize([content, viewport], hold);
    return () => {
      viewport.removeEventListener("scroll", record);
      stopObserving();
    };
  }, [anchorRef]);
}
