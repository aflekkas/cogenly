import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** Each list's last scroll offset, kept while the sidebar unmounts on Settings. */
const scrollTopByList = new Map<string, number>();

const viewportOf = (element: HTMLElement | null) =>
  element?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

/**
 * Keeps the sidebar list's scroll position per `listKey` (a mode, or search):
 * switching to another list and back, or visiting Settings, returns to the
 * same rows. A list never seen before keeps the viewport where it is.
 * `anchorRef` is any element inside the list's scroll viewport.
 */
export function useSidebarScrollMemory(anchorRef: RefObject<HTMLElement | null>, listKey: string) {
  const listKeyRef = useRef(listKey);
  // Before paint, so the new list never shows at the old list's offset.
  useLayoutEffect(() => {
    listKeyRef.current = listKey;
    const viewport = viewportOf(anchorRef.current);
    const saved = scrollTopByList.get(listKey);
    if (viewport !== null && saved !== undefined) viewport.scrollTop = saved;
  }, [anchorRef, listKey]);
  useEffect(() => {
    const viewport = viewportOf(anchorRef.current);
    if (viewport === null) return;
    const record = () => scrollTopByList.set(listKeyRef.current, viewport.scrollTop);
    viewport.addEventListener("scroll", record, { passive: true });
    return () => viewport.removeEventListener("scroll", record);
  }, [anchorRef]);
}
