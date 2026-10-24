import type { PreviewAnnotationPayload } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  annotationAnchorRect,
  clientToPagePoint,
  fitFrame,
  pageRectToBox,
  pickMarkers,
  resolvePickGesture,
} from "./serverBrowserPick";

// A 1000x500 page streamed as a 2000x1000 frame into a 600x600 canvas at (100, 50):
// object-contain letterboxes it to 600x300 with 150px bars above and below.
const page = { width: 1000, height: 500 };
const canvas = { left: 100, top: 50, width: 600, height: 600, frameWidth: 2000, frameHeight: 1000 };

describe("canvas to page mapping", () => {
  it("subtracts the letterbox bars before scaling", () => {
    expect(clientToPagePoint(canvas, page, 100, 200, false)).toEqual({
      x: 0,
      y: 0,
      scale: 1000 / 600,
    });
    expect(clientToPagePoint(canvas, page, 400, 350, false)).toMatchObject({ x: 500, y: 250 });
    expect(clientToPagePoint(canvas, page, 700, 500, false)).toMatchObject({ x: 1000, y: 500 });
  });

  it("misses in the bars unless clamped, which pins to the nearest edge", () => {
    expect(clientToPagePoint(canvas, page, 400, 100, false)).toBeNull();
    expect(clientToPagePoint(canvas, page, 400, 100, true)).toMatchObject({ x: 500, y: 0 });
    expect(clientToPagePoint(canvas, page, 900, 600, true)).toMatchObject({ x: 1000, y: 500 });
  });

  it("has no point before a frame has painted", () => {
    expect(clientToPagePoint({ ...canvas, frameWidth: 0 }, page, 400, 350, true)).toBeNull();
  });

  it("lays page rects back over the same letterboxed frame", () => {
    const frame = fitFrame(canvas, page);
    expect(frame).toEqual({ left: 0, top: 150, width: 600, height: 300 });
    const box = pageRectToBox({ x: 500, y: 250, width: 100, height: 50 }, frame!, page);
    expect(box).toEqual({ left: 300, top: 300, width: 60, height: 30 });
    // Round trip: the box's corner maps back to the rect's corner.
    const corner = clientToPagePoint(
      canvas,
      page,
      canvas.left + box.left,
      canvas.top + box.top,
      false,
    );
    expect(corner).toMatchObject({ x: 500, y: 250 });
  });
});

describe("pick gestures", () => {
  const at = (x: number, y: number) => ({ x, y });

  it("treats a press that barely moved as an element click at the press point", () => {
    expect(
      resolvePickGesture({
        startClient: at(10, 10),
        endClient: at(13, 12),
        startPage: at(40, 60),
        endPage: at(45, 63),
        page,
      }),
    ).toEqual({ kind: "element", x: 40, y: 60 });
  });

  it("turns a drag in any direction into a positive region pinned inside the page", () => {
    expect(
      resolvePickGesture({
        startClient: at(200, 200),
        endClient: at(100, 120),
        startPage: at(300, 200),
        endPage: at(-20, 80),
        page,
      }),
    ).toEqual({ kind: "region", rect: { x: 0, y: 80, width: 300, height: 120 } });
  });

  it("drops a drag too thin to crop", () => {
    expect(
      resolvePickGesture({
        startClient: at(0, 0),
        endClient: at(40, 0),
        startPage: at(10, 10),
        endPage: at(80, 10.5),
        page,
      }),
    ).toBeNull();
  });
});

const annotation = (
  id: string,
  pageUrl: string,
  target: { element?: boolean; rect: { x: number; y: number; width: number; height: number } },
): PreviewAnnotationPayload => ({
  id,
  pageUrl,
  pageTitle: null,
  comment: "",
  elements: target.element
    ? [
        {
          id: `${id}-el`,
          rect: target.rect,
          element: {
            pageUrl,
            pageTitle: null,
            tagName: "button",
            selector: null,
            htmlPreview: "",
            componentName: null,
            source: null,
            stack: [],
            styles: "",
            pickedAt: "",
          },
        },
      ]
    : [],
  regions: target.element ? [] : [{ id: `${id}-region`, rect: target.rect }],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "",
});

describe("stacked annotation markers", () => {
  const url = "https://example.com/";
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it("numbers markers by composer order and keeps only this page's", () => {
    const stacked = [
      annotation("a", url, { element: true, rect }),
      annotation("b", "https://other.example/", { element: true, rect }),
      annotation("c", url, { rect: { x: 1, y: 2, width: 3, height: 4 } }),
    ];
    expect(pickMarkers(stacked, url)).toEqual([
      { id: "a", number: 1, rect, stack: 0 },
      { id: "c", number: 3, rect: { x: 1, y: 2, width: 3, height: 4 }, stack: 0 },
    ]);
  });

  it("skips restored annotations without geometry but still counts them", () => {
    const stacked = [
      annotation("restored", url, { element: true, rect: { x: 0, y: 0, width: 0, height: 0 } }),
      annotation("fresh", url, { element: true, rect }),
    ];
    expect(annotationAnchorRect(stacked[0]!)).toBeNull();
    expect(pickMarkers(stacked, url)).toEqual([{ id: "fresh", number: 2, rect, stack: 0 }]);
  });

  it("fans out badges for picks of the same spot so each number stays readable", () => {
    const stacked = [
      annotation("a", url, { element: true, rect }),
      annotation("b", url, { element: true, rect: { ...rect, x: rect.x + 2 } }),
      annotation("c", url, { element: true, rect: { ...rect, y: rect.y + 200 } }),
    ];
    expect(pickMarkers(stacked, url).map((marker) => marker.stack)).toEqual([0, 1, 0]);
  });

  it("shows nothing on a blank tab", () => {
    expect(pickMarkers([annotation("a", "", { element: true, rect })], "")).toEqual([]);
  });
});
