import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";

import {
  offsetFromEdge,
  scrollTopForOffset,
  type SidebarListEdge,
} from "./sidebarListAnchor.logic";

/** Each list's distance from its anchored edge, kept while the sidebar unmounts on Settings. */
const offsetByList = new Map<string, number>();

const viewportOf = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

/** The list and box each viewport was last held for. */
const heldByViewport = new WeakMap<
  HTMLElement,
  { readonly listKey: string; readonly scrollHeight: number; readonly clientHeight: number }
>();

/**
 * Puts `viewport` back at `listKey`'s distance from `edge` (0, against it, for
 * a new list), when the list changed or its rows or viewport resized. Left
 * alone otherwise, so a render mid-scroll never tugs against the user.
 */
function holdOffset(viewport: HTMLElement, listKey: string, edge: SidebarListEdge) {
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
  const next = scrollTopForOffset(edge, offsetByList.get(listKey) ?? 0, viewport);
  if (Math.abs(viewport.scrollTop - next) >= 1) viewport.scrollTop = next;
}

/**
 * Anchors a sidebar list's scroll to one edge. A "bottom" list fills from the
 * bottom like a log: it opens on its last rows (by the dock), remembers its
 * place as a distance from them, and holds that distance while rows change, so
 * a list resting on its last rows stays there and a page revealed above never
 * moves what is on screen. A "top" list does the same from its first rows.
 *
 * `listKey` names the list (a mode and its filter, or search): each keeps its
 * own place, and one never seen before opens against its edge. `anchorRef` is
 * the element holding the list's rows, inside the scroll viewport.
 *
 * Call it before any layout effect that measures rows (the list motion): it
 * settles the scroll in the same commit, so they measure where rows will paint.
 */
export function useSidebarListAnchor(
  anchorRef: RefObject<HTMLElement | null>,
  listKey: string,
  edge: SidebarListEdge,
) {
  const current = useRef({ listKey, edge });
  current.current = { listKey, edge };
  // Every commit, before paint: the rows this render drew hold their place,
  // and a list switched to lands at its own offset.
  useLayoutEffect(() => {
    const viewport = viewportOf(anchorRef.current);
    if (viewport !== null) holdOffset(viewport, listKey, edge);
  });
  useEffect(() => {
    const content = anchorRef.current;
    const viewport = viewportOf(content);
    if (content === null || viewport === null) return;
    const record = () =>
      offsetByList.set(current.current.listKey, offsetFromEdge(current.current.edge, viewport));
    // Rows that change outside a render here (another list component's own
    // updates, images, folds settling) or a resized viewport hold the same way.
    const hold = () => holdOffset(viewport, current.current.listKey, current.current.edge);
    viewport.addEventListener("scroll", record, { passive: true });
    const stopObserving = observeResize([content, viewport], hold);
    return () => {
      viewport.removeEventListener("scroll", record);
      stopObserving();
    };
  }, [anchorRef]);
}
