/**
 * The drawing model behind image markup: shapes in the image's natural pixel
 * coordinates, an undo stack of shape lists, and the geometry that turns a
 * pointer on the zoomed canvas into an image point and the shapes into paths
 * for both the live SVG overlay and the flattened PNG. Nothing here touches
 * the DOM, so the rules can be tested.
 */

import type { ImageView, Size } from "./zoomableImageView";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type MarkupTool = "pen" | "arrow" | "rect" | "text" | "highlighter" | "hand";
export type MarkupStrokeSize = "S" | "M" | "L";

export interface MarkupSwatch {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export const MARKUP_SWATCHES: ReadonlyArray<MarkupSwatch> = [
  { id: "red", label: "Red", color: "#ef4444" },
  { id: "yellow", label: "Yellow", color: "#facc15" },
  { id: "green", label: "Green", color: "#22c55e" },
  { id: "blue", label: "Blue", color: "#3b82f6" },
  { id: "black", label: "Black", color: "#111111" },
  { id: "white", label: "White", color: "#ffffff" },
];
export const DEFAULT_MARKUP_COLOR = "#ef4444";
export const MARKUP_STROKE_SIZES: ReadonlyArray<MarkupStrokeSize> = ["S", "M", "L"];
export const HIGHLIGHTER_OPACITY = 0.4;

/** Single-key tool shortcuts; the hand tool is held with Space. */
export const MARKUP_TOOL_SHORTCUTS: Readonly<Record<string, MarkupTool>> = {
  p: "pen",
  a: "arrow",
  r: "rect",
  t: "text",
  h: "highlighter",
};

interface ShapeStyle {
  readonly id: string;
  readonly color: string;
  /** Stroke width (or font size for text) in natural image pixels. */
  readonly width: number;
}

export type MarkupShape =
  | (ShapeStyle & { readonly kind: "pen" | "highlighter"; readonly points: ReadonlyArray<Point> })
  | (ShapeStyle & { readonly kind: "arrow" | "rect"; readonly from: Point; readonly to: Point })
  | (ShapeStyle & { readonly kind: "text"; readonly at: Point; readonly text: string });

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

const STROKE_FACTORS: Record<MarkupStrokeSize, { factor: number; min: number }> = {
  S: { factor: 0.003, min: 2 },
  M: { factor: 0.006, min: 3 },
  L: { factor: 0.012, min: 6 },
};
const FONT_FACTORS: Record<MarkupStrokeSize, { factor: number; min: number }> = {
  S: { factor: 0.02, min: 12 },
  M: { factor: 0.03, min: 16 },
  L: { factor: 0.045, min: 24 },
};
const HIGHLIGHTER_WIDTH_RATIO = 4;

const longSide = (natural: Size) => Math.max(natural.width, natural.height, 1);
const round2 = (value: number) => Math.round(value * 100) / 100;

/** A stroke width in image pixels that reads the same at any image resolution. */
export function strokeWidthFor(
  size: MarkupStrokeSize,
  natural: Size,
  tool: MarkupTool = "pen",
): number {
  const { factor, min } = STROKE_FACTORS[size];
  const base = Math.max(min, factor * longSide(natural));
  return round2(tool === "highlighter" ? base * HIGHLIGHTER_WIDTH_RATIO : base);
}

export function fontSizeFor(size: MarkupStrokeSize, natural: Size): number {
  const { factor, min } = FONT_FACTORS[size];
  return round2(Math.max(min, factor * longSide(natural)));
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/** A point on the canvas (relative to its top-left) in the image's natural pixels. */
export function canvasToImagePoint(canvas: Point, view: ImageView): Point {
  return { x: (canvas.x - view.x) / view.scale, y: (canvas.y - view.y) / view.scale };
}

/** An image point back to canvas coordinates: the inverse of `canvasToImagePoint`. */
export function imageToCanvasPoint(image: Point, view: ImageView): Point {
  return { x: image.x * view.scale + view.x, y: image.y * view.scale + view.y };
}

/**
 * How far past each edge of the image markup may reach, as a share of the
 * image's long side. The space around the image is a canvas too; this keeps
 * one stray drag from blowing the flattened PNG up to an empty expanse.
 */
export const MARKUP_OUTSIDE_RATIO = 0.5;

/** A drawn point, kept within the image plus the reach around it. */
export function clampToMarkupArea(point: Point, natural: Size): Point {
  const reach = longSide(natural) * MARKUP_OUTSIDE_RATIO;
  return {
    x: Math.min(natural.width + reach, Math.max(-reach, point.x)),
    y: Math.min(natural.height + reach, Math.max(-reach, point.y)),
  };
}

export interface MarkupBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A text label's width in image pixels: measured when a canvas can, estimated otherwise. */
export type MeasureMarkupText = (text: string, fontSize: number) => number;
const estimateTextWidth: MeasureMarkupText = (text, fontSize) => text.length * fontSize * 0.62;

/** The box a shape paints, stroke and arrowhead included. */
export function shapeBounds(
  shape: MarkupShape,
  measureText: MeasureMarkupText = estimateTextWidth,
): MarkupBounds {
  if (shape.kind === "text") {
    const halo = textHaloWidth(shape.width) / 2;
    return {
      x: shape.at.x - halo,
      y: shape.at.y - halo,
      width: measureText(shape.text, shape.width) + halo * 2,
      height: shape.width * 1.25 + halo * 2,
    };
  }
  let points: ReadonlyArray<Point>;
  switch (shape.kind) {
    case "pen":
    case "highlighter":
      points = shape.points;
      break;
    case "arrow":
      points = [shape.from, shape.to, ...arrowHead(shape.from, shape.to, shape.width)];
      break;
    case "rect":
      points = [shape.from, shape.to];
      break;
  }
  const half = shape.width / 2;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - half;
  const minY = Math.min(...ys) - half;
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) + half - minX,
    height: Math.max(...ys) + half - minY,
  };
}

/**
 * The flattened canvas in image pixels: the image, grown to hold every shape
 * drawn past its edges plus a small margin on the sides that grew. Each side
 * stops at the reach `clampToMarkupArea` allows.
 */
export function markupCanvasBounds(
  natural: Size,
  shapes: ReadonlyArray<MarkupShape>,
  measureText?: MeasureMarkupText,
): MarkupBounds {
  const reach = longSide(natural) * MARKUP_OUTSIDE_RATIO;
  const margin = Math.max(8, longSide(natural) * 0.01);
  let left = 0;
  let top = 0;
  let right = natural.width;
  let bottom = natural.height;
  for (const shape of shapes) {
    const box = shapeBounds(shape, measureText);
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  const grow = (edge: number, image: number, sign: -1 | 1) =>
    edge === image ? image : image + sign * Math.min(reach, Math.abs(edge - image) + margin);
  const x = Math.floor(grow(left, 0, -1));
  const y = Math.floor(grow(top, 0, -1));
  return {
    x,
    y,
    width: Math.ceil(grow(right, natural.width, 1)) - x,
    height: Math.ceil(grow(bottom, natural.height, 1)) - y,
  };
}

/** Browsers refuse canvases past these; a larger image flattens scaled down to fit. */
export const MAX_CANVAS_SIDE = 16_384;
export const MAX_CANVAS_AREA = 16_384 * 4_096;

/** The flattened PNG's size: the original resolution unless a canvas cannot hold it. */
export function flattenTarget(natural: Size): { width: number; height: number; scale: number } {
  const width = Math.max(1, Math.round(natural.width));
  const height = Math.max(1, Math.round(natural.height));
  const scale = Math.min(
    1,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/** The markup's file name: the original's base name as a PNG. */
export function markupFileName(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base || "image"}.png`;
}

// ---------------------------------------------------------------------------
// Stroke building
// ---------------------------------------------------------------------------

/**
 * Appends a pointer sample to a freehand stroke unless it is closer than
 * `minDistance` (image pixels) to the last kept one, which drops the jitter a
 * slow hand produces and keeps the path short.
 */
export function appendStrokePoint(
  points: ReadonlyArray<Point>,
  point: Point,
  minDistance: number,
): ReadonlyArray<Point> {
  const last = points.at(-1);
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < minDistance) return points;
  return [...points, point];
}

export function rectFromPoints(from: Point, to: Point) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Whether a finished shape shows anything: a click without a drag makes no arrow or box. */
export function isMeaningfulShape(shape: MarkupShape, minLength: number): boolean {
  switch (shape.kind) {
    case "pen":
    case "highlighter":
      return shape.points.length > 0;
    case "arrow":
      return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= minLength;
    case "rect": {
      const rect = rectFromPoints(shape.from, shape.to);
      return rect.width >= minLength && rect.height >= minLength;
    }
    case "text":
      return shape.text.trim().length > 0;
  }
}

// ---------------------------------------------------------------------------
// Paths (SVG path data, also fed to canvas Path2D when flattening)
// ---------------------------------------------------------------------------

const n = (value: number) => String(round2(value));

/**
 * A freehand stroke as quadratic curves through the midpoints of its samples,
 * with each sample as a control point. This smooths the polyline without
 * lagging behind the pointer. A single sample draws a dot (round caps).
 */
export function smoothStrokePath(points: ReadonlyArray<Point>): string {
  const [first, second] = points;
  if (!first) return "";
  if (!second) return `M${n(first.x)} ${n(first.y)}L${n(first.x)} ${n(first.y)}`;
  if (points.length === 2) return `M${n(first.x)} ${n(first.y)}L${n(second.x)} ${n(second.y)}`;
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index]!;
    const next = points[index + 1]!;
    d += `Q${n(control.x)} ${n(control.y)} ${n((control.x + next.x) / 2)} ${n((control.y + next.y) / 2)}`;
  }
  const last = points.at(-1)!;
  return `${d}L${n(last.x)} ${n(last.y)}`;
}

/** The two barbs of an arrowhead at `to`, sized from the stroke width. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.min(
    width * 4 + 6,
    Math.max(width * 2, Math.hypot(to.x - from.x, to.y - from.y) * 0.6),
  );
  const spread = Math.PI / 7;
  return [
    {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread),
    },
    {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread),
    },
  ];
}

/** Stroked path data for every shape but text, which is drawn as glyphs. */
export function shapePath(shape: MarkupShape): string {
  switch (shape.kind) {
    case "pen":
    case "highlighter":
      return smoothStrokePath(shape.points);
    case "arrow": {
      const [left, right] = arrowHead(shape.from, shape.to, shape.width);
      const { from, to } = shape;
      return `M${n(from.x)} ${n(from.y)}L${n(to.x)} ${n(to.y)}M${n(left.x)} ${n(left.y)}L${n(to.x)} ${n(to.y)}L${n(right.x)} ${n(right.y)}`;
    }
    case "rect": {
      const { x, y, width, height } = rectFromPoints(shape.from, shape.to);
      return `M${n(x)} ${n(y)}H${n(x + width)}V${n(y + height)}H${n(x)}Z`;
    }
    case "text":
      return "";
  }
}

export function shapeOpacity(shape: MarkupShape): number {
  return shape.kind === "highlighter" ? HIGHLIGHTER_OPACITY : 1;
}

/** A halo behind text so it reads on any background: dark for white text, white otherwise. */
export function textHaloColor(color: string): string {
  return color.toLowerCase() === "#ffffff" ? "#111111" : "#ffffff";
}

export const textHaloWidth = (fontSize: number) => round2(Math.max(2, fontSize * 0.16));
/** Text is drawn from its top-left, one line, bold. */
export const MARKUP_TEXT_WEIGHT = 600;

// ---------------------------------------------------------------------------
// Undo stack
// ---------------------------------------------------------------------------

export interface MarkupHistory {
  readonly past: ReadonlyArray<ReadonlyArray<MarkupShape>>;
  readonly present: ReadonlyArray<MarkupShape>;
  readonly future: ReadonlyArray<ReadonlyArray<MarkupShape>>;
}

const HISTORY_LIMIT = 200;

export function createMarkupHistory(shapes: ReadonlyArray<MarkupShape> = []): MarkupHistory {
  return { past: [], present: shapes, future: [] };
}

/** Records a new shape list as one undo step and drops the redo branch. */
export function commitShapes(
  history: MarkupHistory,
  shapes: ReadonlyArray<MarkupShape>,
): MarkupHistory {
  if (shapes === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: shapes,
    future: [],
  };
}

export function addShape(history: MarkupHistory, shape: MarkupShape): MarkupHistory {
  return commitShapes(history, [...history.present, shape]);
}

/** Clearing is one undoable step; clearing nothing records nothing. */
export function clearShapes(history: MarkupHistory): MarkupHistory {
  return history.present.length === 0 ? history : commitShapes(history, []);
}

export function undoMarkup(history: MarkupHistory): MarkupHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoMarkup(history: MarkupHistory): MarkupHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export const canUndoMarkup = (history: MarkupHistory) => history.past.length > 0;
export const canRedoMarkup = (history: MarkupHistory) => history.future.length > 0;
