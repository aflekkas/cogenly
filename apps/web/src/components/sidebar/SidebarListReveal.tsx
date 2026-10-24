import { useCallback, useEffect, useState } from "react";

// How far outside the visible list the next page starts rendering, so it is
// in place before the user scrolls to it.
const REVEAL_MARGIN_PX = 320;

const viewportOf = (element: Element) =>
  element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');

/** Pages revealed per list and reset key, so they survive the sidebar unmounting on Settings. */
const revealedCounts = new Map<string, number>();

/**
 * Paging for a sidebar list whose rows are all on the client: `count` rows
 * render, and `reveal` adds a page below them. Each `resetKey` (a mode) keeps
 * the pages it revealed, so switching modes and back shows the same rows, and
 * the list's scroll position (useSidebarListAnchor) lands where it was.
 * `listKey` tells lists sharing a reset key apart.
 */
export function useSidebarListReveal(options: {
  readonly listKey: string;
  readonly resetKey: string;
  readonly initialCount: number;
  readonly pageCount: number;
}) {
  const { listKey, resetKey, initialCount, pageCount } = options;
  const memoryKey = `${listKey}:${resetKey}`;
  const [state, setState] = useState(() => ({
    memoryKey,
    count: revealedCounts.get(memoryKey) ?? initialCount,
  }));
  const count =
    state.memoryKey === memoryKey ? state.count : (revealedCounts.get(memoryKey) ?? initialCount);
  const reveal = useCallback(() => {
    setState((previous) => {
      const next =
        (previous.memoryKey === memoryKey
          ? previous.count
          : (revealedCounts.get(memoryKey) ?? initialCount)) + pageCount;
      revealedCounts.set(memoryKey, next);
      return { memoryKey, count: next };
    });
  }, [initialCount, memoryKey, pageCount]);
  return { count, reveal };
}

/**
 * Sits after the last row of a paged list that still has hidden rows, and
 * asks for the next page as it nears the viewport. Key it by the rendered
 * count so it remounts after each page: one request per mount, and a sentinel
 * still in view asks again.
 */
export function SidebarListRevealSentinel(props: { readonly onReveal: () => void }) {
  const { onReveal } = props;
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
  useEffect(() => {
    if (sentinel === null) return;
    let requested = false;
    const request = () => {
      if (requested) return;
      requested = true;
      onReveal();
    };
    if (typeof IntersectionObserver === "undefined") {
      request();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) request();
      },
      { root: viewportOf(sentinel), rootMargin: `0px 0px ${REVEAL_MARGIN_PX}px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onReveal, sentinel]);
  return <li ref={setSentinel} aria-hidden className="h-px list-none" />;
}
