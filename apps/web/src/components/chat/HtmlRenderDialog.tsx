import type { ScopedThreadRef } from "@t3tools/contracts";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

/** Breathing room between the page and the canvas edge, in screen pixels. */
const PAD = 40;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const ZOOM_EASE_MS = 180;
/** A page whose height tracks its frame's could otherwise grow without end. */
const MAX_PAGE_HEIGHT = 20_000;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))
  );
}

/**
 * An HTML render full screen, as a canvas: the page at its full height on the
 * theme background with room around it. Two-finger scroll pans (natively, so it
 * also works over the page); ⌘-scroll or pinch zooms around the cursor; a drag
 * on the margin, or anywhere with space held, pans; double-click, 0 or ⌘0 fit
 * the page to the width again. Space-held panning lays a capture layer over
 * the page, so clicks reach the page the rest of the time.
 */
export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly title: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [contentHeight, setContentHeight] = useState<number>();
  const [zoom, setZoom] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
    return observeResize(scroller, ([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  }, []);

  // The page is laid out at the width that fits the canvas at 100%, and as
  // tall as it reports, so it never scrolls inside its own frame.
  const pageWidth = Math.max(1, viewport.width - 2 * PAD);
  const pageHeight = Math.min(
    MAX_PAGE_HEIGHT,
    contentHeight ?? Math.max(1, viewport.height - 2 * PAD),
  );
  const geometry = useCallback(
    (z: number) => {
      const width = pageWidth * z;
      const height = pageHeight * z;
      return {
        left: Math.max(PAD, (viewport.width - width) / 2),
        top: Math.max(PAD, (viewport.height - height) / 2),
        width: Math.max(viewport.width, width + 2 * PAD),
        height: Math.max(viewport.height, height + 2 * PAD),
      };
    },
    [pageWidth, pageHeight, viewport.width, viewport.height],
  );
  const view = geometry(zoom);

  // Scroll that belongs to the zoom being rendered, applied once the canvas
  // has its new size.
  const pendingScroll = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const scroll = pendingScroll.current;
    if (!scroller || !scroll) return;
    pendingScroll.current = null;
    scroller.scrollTo(scroll.x, scroll.y);
  });

  // The zoom last asked for, read by gestures between renders.
  const zoomRef = useRef(zoom);
  const animation = useRef(0);
  const stopAnimation = () => cancelAnimationFrame(animation.current);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  /** Moves to `to` with the page's point under (cx, cy) kept there, or to `scroll` if given. */
  const zoomTo = (
    to: number,
    anchor: { readonly cx: number; readonly cy: number },
    options: { readonly animate: boolean; readonly scroll?: { x: number; y: number } },
  ) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stopAnimation();
    const from = zoomRef.current;
    const target = clampZoom(to);
    const start = geometry(from);
    const px = (scroller.scrollLeft + anchor.cx - start.left) / from;
    const py = (scroller.scrollTop + anchor.cy - start.top) / from;
    const scrollAt = (z: number) => {
      const next = geometry(z);
      return { x: px * z + next.left - anchor.cx, y: py * z + next.top - anchor.cy };
    };
    const end = options.scroll ?? scrollAt(target);
    const apply = (z: number, scroll: { x: number; y: number }) => {
      pendingScroll.current = scroll;
      if (z === zoomRef.current) {
        scroller.scrollTo(scroll.x, scroll.y);
        return;
      }
      zoomRef.current = z;
      setZoom(z);
    };
    if (!options.animate || reducedMotion()) {
      apply(target, end);
      return;
    }
    const begin = { x: scroller.scrollLeft, y: scroller.scrollTop };
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = easeOut(Math.min(1, (now - startedAt) / ZOOM_EASE_MS));
      const z = from + (target - from) * t;
      const anchored = options.scroll === undefined ? scrollAt(z) : null;
      apply(
        t === 1 ? target : z,
        t === 1
          ? end
          : (anchored ?? {
              x: begin.x + (end.x - begin.x) * t,
              y: begin.y + (end.y - begin.y) * t,
            }),
      );
      if (t < 1) animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
  };
  const center = () => ({ cx: viewport.width / 2, cy: viewport.height / 2 });
  const fit = () => zoomTo(1, center(), { animate: true, scroll: { x: 0, y: 0 } });
  const zoomBy = (factor: number) => zoomTo(zoomRef.current * factor, center(), { animate: true });

  // Latest handlers for the listeners bound once below.
  const handlers = useRef({ zoomTo, fit });
  useEffect(() => {
    handlers.current = { zoomTo, fit };
  });

  // ⌘-scroll and pinch (which arrives as ctrl-scroll) zoom around the cursor.
  // Plain scroll pans natively, except over the capture layer, which is not
  // inside the scroller.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = stageRef.current;
    const scroller = scrollerRef.current;
    if (!stage || !scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = scroller.getBoundingClientRect();
        handlers.current.zoomTo(
          zoomRef.current * Math.exp(-event.deltaY * 0.01),
          { cx: event.clientX - rect.left, cy: event.clientY - rect.top },
          { animate: false },
        );
      } else if (!scroller.contains(event.target as Node)) {
        event.preventDefault();
        scroller.scrollBy(event.deltaX, event.deltaY);
      }
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === " ") {
        // Space pans rather than paging the canvas down.
        event.preventDefault();
        setSpaceHeld(true);
      } else if (event.key === "0" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handlers.current.fit();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    const release = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.button !== 0) return;
    // The page takes its own pointer events; only the margin and the capture
    // layer start a pan.
    if (event.target instanceof HTMLIFrameElement) return;
    stopAnimation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
    };
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    scrollerRef.current?.scrollTo(
      start.left - (event.clientX - start.x),
      start.top - (event.clientY - start.y),
    );
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  const panHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: (event: React.MouseEvent) => {
      if (!(event.target instanceof HTMLIFrameElement)) fit();
    },
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={scrollerRef}
      >
        <DialogTitle className="sr-only">Expanded {props.title} preview</DialogTitle>
        <div className="relative w-[92vw]">
          <Button
            aria-label="Close"
            size="icon-sm"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
          <div
            ref={stageRef}
            className="relative h-[min(86vh,calc(100vh-160px))] overflow-hidden rounded-lg bg-background shadow-2xl ring-1 ring-border/70"
          >
            <div
              ref={scrollerRef}
              tabIndex={0}
              aria-label={`${props.title}, full screen`}
              className={cn(
                "size-full overflow-auto overscroll-contain outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                dragging ? "cursor-grabbing" : "cursor-grab",
              )}
              {...panHandlers}
            >
              <div className="relative" style={{ width: view.width, height: view.height }}>
                <div
                  className="absolute top-0 left-0 origin-top-left will-change-transform"
                  style={{
                    width: pageWidth,
                    height: pageHeight,
                    transform: `translate(${view.left}px, ${view.top}px) scale(${zoom})`,
                  }}
                >
                  <HtmlRenderDocument
                    src={props.src}
                    title={props.title}
                    threadRef={props.threadRef}
                    className="block size-full"
                    onContentHeight={setContentHeight}
                  />
                </div>
              </div>
            </div>
            {spaceHeld || dragging ? (
              // Over the page while panning, so the page sees neither the drag nor its end.
              <div
                aria-hidden
                className={cn("absolute inset-0", dragging ? "cursor-grabbing" : "cursor-grab")}
                {...panHandlers}
              />
            ) : null}
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{props.title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-label="Zoom out"
                size="icon-sm"
                variant="overlay"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => zoomBy(1 / ZOOM_STEP)}
              >
                <MinusIcon />
              </Button>
              <span className="w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <Button
                aria-label="Zoom in"
                size="icon-sm"
                variant="overlay"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => zoomBy(ZOOM_STEP)}
              >
                <PlusIcon />
              </Button>
              <Button aria-label="Fit to width" size="sm" variant="overlay" onClick={fit}>
                Fit
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
