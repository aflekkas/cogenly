import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// How far outside the visible list the next page starts rendering, so it is
// in place before the user scrolls to it.
const REVEAL_MARGIN_PX = 320;

const viewportOf = (element: Element) =>
  element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');

/** The scroll state from before a page landed above the visible rows. */
type RevealAnchor = {
  readonly viewport: HTMLElement;
  readonly scrollTop: number;
  readonly scrollHeight: number;
};

/** Pages revealed per list and reset key, so they survive the sidebar unmounting on Settings. */
const revealedCounts = new Map<string, number>();

/**
 * Paging for a sidebar list whose rows are all on the client: `count` rows
 * render, and `reveal` adds a page. Each `resetKey` (a mode) keeps the pages
 * it revealed, so switching modes and back shows the same rows, and the list's
 * scroll position (useSidebarListAnchor) lands where it was. `listKey` tells
 * lists sharing a reset key apart.
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
  const anchorRef = useRef<RevealAnchor | null>(null);
  /** Pass the scroll viewport when the page lands above the visible rows. */
  const reveal = useCallback(
    (viewport?: HTMLElement | null) => {
      anchorRef.current =
        viewport == null
          ? null
          : { viewport, scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight };
      setState((previous) => {
        const next =
          (previous.memoryKey === memoryKey
            ? previous.count
            : (revealedCounts.get(memoryKey) ?? initialCount)) + pageCount;
        revealedCounts.set(memoryKey, next);
        return { memoryKey, count: next };
      });
    },
    [initialCount, memoryKey, pageCount],
  );
  // The sidebar viewport opts out of browser scroll anchoring, so a page
  // that lands above the visible rows would push them down. Everything it
  // adds is above them, so scrolling by the growth keeps them still (and a
  // bottom-anchored list that only now overflows grows by exactly that much).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor === null || !anchor.viewport.isConnected) return;
    anchor.viewport.scrollTop =
      anchor.scrollTop + anchor.viewport.scrollHeight - anchor.scrollHeight;
  }, [count]);
  return { count, reveal };
}

/**
 * Sits at the end of a paged list that still has hidden rows, and asks for
 * the next page as it nears the viewport. `edge` is where it sits: a list
 * that grows upward (newest at the bottom) keeps it above its first row.
 * Key it by the rendered count so it remounts after each page: one request
 * per mount, and a sentinel still in view asks again.
 */
export function SidebarListRevealSentinel(props: {
  readonly edge: "top" | "bottom";
  readonly onReveal: (viewport: HTMLElement | null) => void;
}) {
  const { edge, onReveal } = props;
  const [sentinel, setSentinel] = useState<HTMLLIElement | null>(null);
  useEffect(() => {
    if (sentinel === null) return;
    const root = viewportOf(sentinel);
    let requested = false;
    const request = () => {
      if (requested) return;
      requested = true;
      onReveal(edge === "top" ? root : null);
    };
    if (typeof IntersectionObserver === "undefined") {
      request();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) request();
      },
      {
        root,
        rootMargin:
          edge === "top"
            ? `${REVEAL_MARGIN_PX}px 0px 0px 0px`
            : `0px 0px ${REVEAL_MARGIN_PX}px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [edge, onReveal, sentinel]);
  return <li ref={setSentinel} aria-hidden className="h-px list-none" />;
}
