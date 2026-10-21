import { describe, expect, it } from "vite-plus/test";

import {
  MAX_CANVAS_AREA,
  MAX_CANVAS_SIDE,
  addShape,
  appendStrokePoint,
  arrowHead,
  canRedoMarkup,
  canUndoMarkup,
  canvasToImagePoint,
  clampToImage,
  clearShapes,
  createMarkupHistory,
  flattenTarget,
  imageToCanvasPoint,
  isMeaningfulShape,
  markupFileName,
  redoMarkup,
  shapePath,
  smoothStrokePath,
  strokeWidthFor,
  undoMarkup,
  type MarkupShape,
} from "./imageMarkup";

const pen = (id: string): MarkupShape => ({
  id,
  kind: "pen",
  color: "#ef4444",
  width: 4,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
  ],
});

describe("markup history", () => {
  it("undoes and redoes shape additions in order", () => {
    let history = createMarkupHistory();
    history = addShape(history, pen("a"));
    history = addShape(history, pen("b"));
    expect(history.present.map((shape) => shape.id)).toEqual(["a", "b"]);

    history = undoMarkup(history);
    expect(history.present.map((shape) => shape.id)).toEqual(["a"]);
    expect(canRedoMarkup(history)).toBe(true);

    history = redoMarkup(history);
    expect(history.present.map((shape) => shape.id)).toEqual(["a", "b"]);
    expect(canRedoMarkup(history)).toBe(false);
  });

  it("drops the redo branch when a new shape lands after an undo", () => {
    let history = addShape(addShape(createMarkupHistory(), pen("a")), pen("b"));
    history = addShape(undoMarkup(history), pen("c"));
    expect(history.present.map((shape) => shape.id)).toEqual(["a", "c"]);
    expect(canRedoMarkup(history)).toBe(false);
  });

  it("makes clear one undoable step and ignores clearing nothing", () => {
    const empty = createMarkupHistory();
    expect(clearShapes(empty)).toBe(empty);

    const cleared = clearShapes(addShape(empty, pen("a")));
    expect(cleared.present).toEqual([]);
    expect(undoMarkup(cleared).present.map((shape) => shape.id)).toEqual(["a"]);
  });

  it("starts from existing shapes with nothing to undo, for re-editing", () => {
    const history = createMarkupHistory([pen("a")]);
    expect(history.present).toHaveLength(1);
    expect(canUndoMarkup(history)).toBe(false);
    expect(undoMarkup(history)).toBe(history);
    expect(redoMarkup(history)).toBe(history);
  });
});

describe("coordinates", () => {
  const view = { scale: 0.5, x: 40, y: 20 };

  it("maps a canvas point into natural image pixels and back", () => {
    const image = canvasToImagePoint({ x: 140, y: 70 }, view);
    expect(image).toEqual({ x: 200, y: 100 });
    expect(imageToCanvasPoint(image, view)).toEqual({ x: 140, y: 70 });
  });

  it("keeps points inside the image", () => {
    expect(clampToImage({ x: -5, y: 900 }, { width: 400, height: 300 })).toEqual({
      x: 0,
      y: 300,
    });
  });

  it("flattens at the original resolution", () => {
    expect(flattenTarget({ width: 2880, height: 1800 })).toEqual({
      width: 2880,
      height: 1800,
      scale: 1,
    });
  });

  it("scales a canvas that browsers cannot hold down to the caps", () => {
    const tall = flattenTarget({ width: 1000, height: 40_000 });
    expect(tall.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(tall.width).toBe(Math.floor(1000 * tall.scale));

    const huge = flattenTarget({ width: 12_000, height: 12_000 });
    expect(huge.width * huge.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    expect(huge.width).toBe(huge.height);
  });
});

describe("strokes", () => {
  it("skips samples closer than the minimum distance", () => {
    let points = appendStrokePoint([], { x: 0, y: 0 }, 2);
    points = appendStrokePoint(points, { x: 1, y: 1 }, 2);
    points = appendStrokePoint(points, { x: 3, y: 0 }, 2);
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("smooths a freehand stroke through the midpoints of its samples", () => {
    expect(
      smoothStrokePath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe("M0 0Q10 0 10 5L10 10");
    expect(smoothStrokePath([{ x: 4, y: 4 }])).toBe("M4 4L4 4");
    expect(smoothStrokePath([])).toBe("");
  });

  it("points the arrowhead barbs back along the shaft", () => {
    const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(left.x).toBeLessThan(100);
    expect(right.x).toBeLessThan(100);
    expect(left.y).toBeCloseTo(-right.y);
  });

  it("draws a rectangle from any two corners", () => {
    expect(
      shapePath({
        id: "r",
        kind: "rect",
        color: "#000",
        width: 2,
        from: { x: 30, y: 40 },
        to: { x: 10, y: 20 },
      }),
    ).toBe("M10 20H30V40H10Z");
  });

  it("drops clicks that made no arrow, box, or text", () => {
    const base = { id: "x", color: "#000", width: 2 } as const;
    const point = { x: 5, y: 5 };
    expect(isMeaningfulShape({ ...base, kind: "arrow", from: point, to: point }, 2)).toBe(false);
    expect(isMeaningfulShape({ ...base, kind: "rect", from: point, to: { x: 50, y: 6 } }, 2)).toBe(
      false,
    );
    expect(isMeaningfulShape({ ...base, kind: "text", at: point, text: "  " }, 2)).toBe(false);
    expect(isMeaningfulShape({ ...base, kind: "pen", points: [point] }, 2)).toBe(true);
  });

  it("sizes strokes from the image so they read the same at any resolution", () => {
    const small = strokeWidthFor("M", { width: 400, height: 300 });
    const large = strokeWidthFor("M", { width: 4000, height: 3000 });
    expect(large).toBeGreaterThan(small);
    expect(strokeWidthFor("M", { width: 4000, height: 3000 }, "highlighter")).toBe(large * 4);
    expect(strokeWidthFor("S", { width: 10, height: 10 })).toBe(2);
  });
});

describe("markupFileName", () => {
  it("keeps the base name and saves as PNG", () => {
    expect(markupFileName("photo.jpeg")).toBe("photo.png");
    expect(markupFileName("Screenshot 2026.10.20.png")).toBe("Screenshot 2026.10.20.png");
    expect(markupFileName(".hidden")).toBe(".hidden.png");
    expect(markupFileName("")).toBe("image.png");
  });
});
