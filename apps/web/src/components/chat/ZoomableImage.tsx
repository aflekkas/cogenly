import { MinusIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { canvasToImagePoint, type Point } from "./imageMarkup";
import {
  IMAGE_ZOOM_STEP,
  clampView,
  fitScale,
  fitView,
  interpolateView,
  panView,
  pannableAxes,
  scaleBounds,
  toggleScale,
  viewsEqual,
  zoomViewAt,
  type CanvasMetrics,
  type ImageView,
  type Size,
} from "./zoomableImageView";

/** Matches the HTML render canvas, and the shared ease-out motion duration. */
const ZOOM_EASE_MS = 180;
const KEY_PAN_STEP = 80;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canvasPad = (viewport: Size) => (viewport.width < 640 ? 16 : 40);

/** Safari's trackpad pinch; Chromium sends a ctrl-wheel instead. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface ZoomableImageHandle {
  /** Handles a canvas key (zoom, fit, 100%, arrow pan); false leaves it to the dialog. */
  handleKey: (event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  }) => boolean;
}

/**
 * Lets a single-pointer drag draw on the image instead of panning it. Points
 * arrive in the image's natural pixels; a second finger cancels the stroke
 * (`onEnd(false)`) and pinches instead.
 */
export interface ZoomableImageDrawing {
  readonly active: boolean;
  readonly onStart: (point: Point, canvas: { view: ImageView; natural: Size }) => void;
  readonly onMove: (point: Point) => void;
  readonly onEnd: (commit: boolean) => void;
}

/** Elements on the canvas that keep their own pointer handling. */
const INTERACTIVE_TARGET = "button, input, textarea";

/**
 * An image on a canvas: it opens fitted inside the padding (never upscaled past
 * 100%), and zooms around the cursor with ⌘/ctrl-scroll or a pinch, up to 8×.
 * Once larger than the canvas it pans by dragging or two-finger scroll, never
 * past its edges. Double-click toggles fit and 100%; the hover control and the
 * +, −, 0 and 1 keys zoom with a short ease.
 */
export function ZoomableImage({
  src,
  name,
  onError,
  ref,
  drawing,
  overlay,
}: {
  src: string;
  name: string;
  onError: () => void;
  ref?: Ref<ZoomableImageHandle>;
  drawing?: ZoomableImageDrawing;
  /** Drawn over the image in its box, which tracks the zoom and pan. */
  overlay?: (view: ImageView, natural: Size) => ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [view, setViewState] = useState<ImageView>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const metrics: CanvasMetrics = { natural, viewport, pad: canvasPad(viewport) };
  const ready = natural.width > 0 && viewport.width > 0;

  // Gestures read and write these between renders.
  const viewRef = useRef(view);
  const metricsRef = useRef(metrics);
  useLayoutEffect(() => {
    metricsRef.current = metrics;
  });
  /** Whether the view tracks the fit, so a resize refits it instead of keeping the zoom. */
  const fittedRef = useRef(true);
  const animation = useRef(0);

  const setView = (next: ImageView) => {
    viewRef.current = next;
    setViewState(next);
  };
  const stopAnimation = () => cancelAnimationFrame(animation.current);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    return observeResize(stage, ([entry]) => {
      if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
  }, []);

  // A new canvas size (or the image's arrival) refits a fitted view and keeps
  // a zoomed one inside its bounds.
  useLayoutEffect(() => {
    if (natural.width === 0 || viewport.width === 0) return;
    cancelAnimationFrame(animation.current);
    const current = { natural, viewport, pad: canvasPad(viewport) };
    const next = fittedRef.current ? fitView(current) : clampView(viewRef.current, current);
    viewRef.current = next;
    setViewState(next);
  }, [natural, viewport]);

  /** Moves to `target`, easing unless the gesture tracks the pointer directly. */
  const show = (
    target: ImageView,
    anchor: { readonly x: number; readonly y: number },
    animate: boolean,
  ) => {
    stopAnimation();
    const current = metricsRef.current;
    fittedRef.current = Math.abs(target.scale - fitScale(current)) < 1e-6;
    const from = viewRef.current;
    if (viewsEqual(from, target)) return;
    if (!animate || reducedMotion()) {
      setView(target);
      return;
    }
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = easeOut(Math.min(1, (now - startedAt) / ZOOM_EASE_MS));
      setView(interpolateView(from, target, t, anchor, metricsRef.current));
      if (t < 1) animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
  };
  const center = () => ({
    x: metricsRef.current.viewport.width / 2,
    y: metricsRef.current.viewport.height / 2,
  });
  const zoomTo = (scale: number, anchor = center(), animate = true) =>
    show(zoomViewAt(viewRef.current, scale, anchor, metricsRef.current), anchor, animate);
  const fit = () => show(fitView(metricsRef.current), center(), true);
  const panBy = (dx: number, dy: number, animate: boolean) =>
    show(panView(viewRef.current, dx, dy, metricsRef.current), center(), animate);
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  // Latest handlers for the listeners bound once below.
  const handlers = useRef({ zoomTo, panBy, toCanvas });
  useEffect(() => {
    handlers.current = { zoomTo, panBy, toCanvas };
  });

  useImperativeHandle(ref, () => ({
    handleKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      const current = metricsRef.current;
      if (current.natural.width === 0) return false;
      const scale = viewRef.current.scale;
      const pannable = pannableAxes(viewRef.current, current);
      switch (event.key) {
        case "+":
        case "=":
          zoomTo(scale * IMAGE_ZOOM_STEP);
          return true;
        case "-":
        case "_":
          zoomTo(scale / IMAGE_ZOOM_STEP);
          return true;
        case "0":
          fit();
          return true;
        case "1":
          zoomTo(1);
          return true;
        // Left and right fall through to gallery navigation unless the image pans that way.
        case "ArrowLeft":
          if (!pannable.x) return false;
          panBy(KEY_PAN_STEP, 0, true);
          return true;
        case "ArrowRight":
          if (!pannable.x) return false;
          panBy(-KEY_PAN_STEP, 0, true);
          return true;
        case "ArrowUp":
          if (!pannable.y) return false;
          panBy(0, KEY_PAN_STEP, true);
          return true;
        case "ArrowDown":
          if (!pannable.y) return false;
          panBy(0, -KEY_PAN_STEP, true);
          return true;
        default:
          return false;
      }
    },
  }));

  // Wheel and pinch track the fingers directly. ⌘/ctrl-scroll and a trackpad
  // pinch (ctrl-wheel in Chromium) zoom around the cursor; plain two-finger
  // scroll pans. The canvas never scrolls natively.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const { zoomTo: zoom, panBy: pan, toCanvas: point } = handlers.current;
      if (event.ctrlKey || event.metaKey) {
        // A mouse wheel notch is ~100px; cap it so one notch is a step, not a leap.
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit));
        zoom(
          viewRef.current.scale * Math.exp(-delta * 0.01),
          point(event.clientX, event.clientY),
          false,
        );
      } else {
        pan(-event.deltaX * unit, -event.deltaY * unit, false);
      }
    };
    let gestureStart = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStart = viewRef.current.scale;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEvent;
      const { zoomTo: zoom, toCanvas: point } = handlers.current;
      zoom(gestureStart * gesture.scale, point(gesture.clientX, gesture.clientY), false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  // Active pointers: one drags, two pinch (touch screens).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  /** The pointer drawing a stroke, while one is. */
  const drawPointer = useRef<number | null>(null);
  const toImage = (clientX: number, clientY: number) =>
    canvasToImagePoint(toCanvas(clientX, clientY), viewRef.current);
  const pinchSpan = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };
  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (drawPointer.current === event.pointerId) {
      drawPointer.current = null;
      drawing?.onEnd(event.type === "pointerup");
    }
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const pannable = ready && pannableAxes(view, metrics);
  const canPan = pannable && (pannable.x || pannable.y);
  const { min, max } = scaleBounds(metrics);

  return (
    <div
      ref={stageRef}
      role="region"
      aria-label={`${name}, zoomable image`}
      aria-description="Scroll or pinch with Command to zoom, drag to pan, double-click for 100%. Plus and minus zoom, 0 fits, 1 shows actual size."
      className={cn(
        "group relative h-(--media-height) w-(--media-width) touch-none overflow-hidden rounded-lg bg-background shadow-2xl ring-1 ring-border/70 select-none",
        drawing?.active
          ? "cursor-crosshair"
          : canPan && (dragging ? "cursor-grabbing" : "cursor-grab"),
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest(INTERACTIVE_TARGET)) return;
        stopAnimation();
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (drawing?.active && ready && pointers.current.size === 1) {
          drawPointer.current = event.pointerId;
          drawing.onStart(toImage(event.clientX, event.clientY), {
            view: viewRef.current,
            natural: metricsRef.current.natural,
          });
          return;
        }
        if (drawPointer.current !== null) {
          drawPointer.current = null;
          drawing?.onEnd(false);
        }
        const span = pinchSpan();
        if (span) pinch.current = { distance: span.distance, scale: viewRef.current.scale };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const last = pointers.current.get(event.pointerId);
        if (!last) return;
        const next = { x: event.clientX, y: event.clientY };
        pointers.current.set(event.pointerId, next);
        if (drawPointer.current === event.pointerId) {
          drawing?.onMove(toImage(next.x, next.y));
          return;
        }
        const span = pinchSpan();
        if (span && pinch.current) {
          zoomTo(
            pinch.current.scale * (span.distance / Math.max(1, pinch.current.distance)),
            toCanvas(span.mid.x, span.mid.y),
            false,
          );
          return;
        }
        panBy(next.x - last.x, next.y - last.y, false);
      }}
      onMouseDown={(event) => {
        // Drawing keeps focus where it is (a text label being typed) and selects nothing.
        if (drawing?.active && !(event.target as Element).closest(INTERACTIVE_TARGET)) {
          event.preventDefault();
        }
      }}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={endPointer}
      onDoubleClick={(event) => {
        if (drawing?.active || (event.target as Element).closest(INTERACTIVE_TARGET)) return;
        zoomTo(
          toggleScale(viewRef.current, metricsRef.current),
          toCanvas(event.clientX, event.clientY),
        );
      }}
    >
      <img
        src={src}
        alt={name}
        draggable={false}
        className={cn(
          "absolute top-0 left-0 block max-w-none origin-top-left transition-opacity duration-(--motion-duration-fast) ease-out",
          ready ? "opacity-100" : "opacity-0",
        )}
        style={
          ready
            ? {
                width: natural.width * view.scale,
                height: natural.height * view.scale,
                transform: `translate(${view.x}px, ${view.y}px)`,
              }
            : undefined
        }
        onLoad={(event) => {
          setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
        }}
        onError={onError}
      />
      {ready && overlay ? (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: natural.width * view.scale,
            height: natural.height * view.scale,
            transform: `translate(${view.x}px, ${view.y}px)`,
          }}
        >
          {overlay(view, natural)}
        </div>
      ) : null}
      {ready ? (
        <div className="absolute right-3 bottom-3 flex items-center gap-1 opacity-0 transition-opacity duration-(--motion-duration-fast) ease-out group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <Button
            aria-label="Zoom out"
            size="icon-sm"
            variant="overlay"
            disabled={view.scale <= min + 1e-6}
            onClick={() => zoomTo(view.scale / IMAGE_ZOOM_STEP)}
          >
            <MinusIcon />
          </Button>
          <Button
            aria-label="Fit to screen"
            size="sm"
            variant="overlay"
            className="min-w-14"
            onClick={fit}
          >
            <span className="tabular-nums">{Math.round(view.scale * 100)}%</span>
          </Button>
          <Button
            aria-label="Zoom in"
            size="icon-sm"
            variant="overlay"
            disabled={view.scale >= max - 1e-6}
            onClick={() => zoomTo(view.scale * IMAGE_ZOOM_STEP)}
          >
            <PlusIcon />
          </Button>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {Math.round(view.scale * 100)}% zoom
      </span>
    </div>
  );
}
