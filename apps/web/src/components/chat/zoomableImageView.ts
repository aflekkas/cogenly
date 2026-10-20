/**
 * Geometry for the expanded image canvas. A view is the image's scale against
 * its natural size and the screen position of its top-left corner inside the
 * canvas. Everything here is pure so the zoom and pan rules can be tested.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ImageView {
  /** Rendered pixels per natural pixel: 1 is 100%. */
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface CanvasMetrics {
  readonly natural: Size;
  readonly viewport: Size;
  /** Breathing room kept between the image and the canvas edge. */
  readonly pad: number;
}

/** The furthest zoom, against the image's natural size. */
export const MAX_IMAGE_SCALE = 8;
export const IMAGE_ZOOM_STEP = 1.5;

/** The scale that shows the whole image inside the padding, never upscaling past 100%. */
export function fitScale({ natural, viewport, pad }: CanvasMetrics): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const room = Math.min(
    (viewport.width - 2 * pad) / natural.width,
    (viewport.height - 2 * pad) / natural.height,
  );
  return Math.min(1, Math.max(room, Number.MIN_VALUE));
}

export function scaleBounds(metrics: CanvasMetrics): { min: number; max: number } {
  const min = fitScale(metrics);
  return { min, max: Math.max(min, MAX_IMAGE_SCALE) };
}

export function clampScale(scale: number, metrics: CanvasMetrics): number {
  const { min, max } = scaleBounds(metrics);
  return Math.min(max, Math.max(min, scale));
}

/** An axis that fits stays centered; a larger one may pan until its edge meets the padding. */
function clampAxis(position: number, length: number, room: number, pad: number): number {
  if (length <= room - 2 * pad) return (room - length) / 2;
  return Math.min(pad, Math.max(room - pad - length, position));
}

/** Keeps the scale in range and the image from being dragged off past its edges. */
export function clampView(view: ImageView, metrics: CanvasMetrics): ImageView {
  const scale = clampScale(view.scale, metrics);
  const { natural, viewport, pad } = metrics;
  return {
    scale,
    x: clampAxis(view.x, natural.width * scale, viewport.width, pad),
    y: clampAxis(view.y, natural.height * scale, viewport.height, pad),
  };
}

export function fitView(metrics: CanvasMetrics): ImageView {
  return clampView({ scale: fitScale(metrics), x: 0, y: 0 }, metrics);
}

/** Zooms to `scale` keeping the image point under `anchor` (canvas coordinates) in place. */
export function zoomViewAt(
  view: ImageView,
  scale: number,
  anchor: { readonly x: number; readonly y: number },
  metrics: CanvasMetrics,
): ImageView {
  const next = clampScale(scale, metrics);
  const imageX = (anchor.x - view.x) / view.scale;
  const imageY = (anchor.y - view.y) / view.scale;
  return clampView(
    { scale: next, x: anchor.x - imageX * next, y: anchor.y - imageY * next },
    metrics,
  );
}

export function panView(
  view: ImageView,
  dx: number,
  dy: number,
  metrics: CanvasMetrics,
): ImageView {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, metrics);
}

/** Whether the image is larger than the canvas on each axis, so it can pan there. */
export function pannableAxes(
  view: ImageView,
  metrics: CanvasMetrics,
): { readonly x: boolean; readonly y: boolean } {
  const { natural, viewport, pad } = metrics;
  return {
    x: natural.width * view.scale > viewport.width - 2 * pad + 0.5,
    y: natural.height * view.scale > viewport.height - 2 * pad + 0.5,
  };
}

/** Double-click goes to 100% and back to fit; an image that fits at 100% toggles 2× instead. */
export function toggleScale(view: ImageView, metrics: CanvasMetrics): number {
  const fit = fitScale(metrics);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  if (near(fit, 1)) return near(view.scale, 1) ? 2 : 1;
  return near(view.scale, 1) ? fit : 1;
}

export function viewsEqual(a: ImageView, b: ImageView): boolean {
  return (
    Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01
  );
}

/**
 * The view part-way from `from` to `to` (t in 0..1). The scale moves
 * geometrically, so each frame zooms by the same ratio, and the image point
 * under `anchor` stays put; any difference between that anchored path and `to`
 * (such as recentering on fit) is blended in over the same time.
 */
export function interpolateView(
  from: ImageView,
  to: ImageView,
  t: number,
  anchor: { readonly x: number; readonly y: number },
  metrics: CanvasMetrics,
): ImageView {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const scale = from.scale * (to.scale / from.scale) ** t;
  const anchored = zoomViewAt(from, scale, anchor, metrics);
  const anchoredEnd = zoomViewAt(from, to.scale, anchor, metrics);
  return clampView(
    {
      scale,
      x: anchored.x + (to.x - anchoredEnd.x) * t,
      y: anchored.y + (to.y - anchoredEnd.y) * t,
    },
    metrics,
  );
}
