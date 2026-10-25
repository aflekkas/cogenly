import type { PreviewAnnotationPayload, PreviewAnnotationRect } from "@cogenly/contracts";

/** Page CSS px size of a streamed tab. */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

/** Where the canvas sits on screen, and its intrinsic frame size in device px. */
export interface CanvasGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

export interface PagePoint {
  readonly x: number;
  readonly y: number;
  /** Page CSS px per client px. */
  readonly scale: number;
}

/** A rect in the canvas box's own px, origin at its top-left. */
export interface BoxRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Maps a client point onto the page. `object-contain` letterboxes the frame
 * inside the canvas box, so the bars are subtracted before scaling. Outside the
 * frame the point is null unless `clamp`, which pins it to the nearest edge.
 */
export function clientToPagePoint(
  canvas: CanvasGeometry,
  page: PageSize,
  clientX: number,
  clientY: number,
  clamp: boolean,
): PagePoint | null {
  if (!(canvas.frameWidth > 0 && canvas.frameHeight > 0)) return null;
  const fit = Math.min(canvas.width / canvas.frameWidth, canvas.height / canvas.frameHeight);
  const width = canvas.frameWidth * fit;
  const height = canvas.frameHeight * fit;
  if (!(width > 0 && height > 0)) return null;
  const scale = page.width / width;
  const x = (clientX - canvas.left - (canvas.width - width) / 2) * scale;
  const y = (clientY - canvas.top - (canvas.height - height) / 2) * (page.height / height);
  const inside = x >= 0 && y >= 0 && x <= page.width && y <= page.height;
  if (!inside && !clamp) return null;
  return {
    x: Math.min(Math.max(x, 0), page.width),
    y: Math.min(Math.max(y, 0), page.height),
    scale,
  };
}

/** The letterboxed frame inside a canvas box of `box` px, as the inverse of `clientToPagePoint`. */
export function fitFrame(
  box: { readonly width: number; readonly height: number },
  frame: { readonly width: number; readonly height: number },
): BoxRect | null {
  if (!(box.width > 0 && box.height > 0 && frame.width > 0 && frame.height > 0)) return null;
  const fit = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** Places a page rect over the letterboxed frame, in canvas-box px. */
export function pageRectToBox(
  rect: PreviewAnnotationRect,
  frame: BoxRect,
  page: PageSize,
): BoxRect {
  const sx = frame.width / page.width;
  const sy = frame.height / page.height;
  return {
    left: frame.left + rect.x * sx,
    top: frame.top + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

/** Movement under this many client px is a click; more is a region drag. */
export const PICK_DRAG_SLOP_PX = 6;

/** A drag between two page points as a positive rect, pinned inside the page. */
export function dragRect(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  page: PageSize,
): PreviewAnnotationRect {
  const clampX = (value: number) => Math.min(Math.max(value, 0), page.width);
  const clampY = (value: number) => Math.min(Math.max(value, 0), page.height);
  const x1 = clampX(Math.min(start.x, end.x));
  const y1 = clampY(Math.min(start.y, end.y));
  const x2 = clampX(Math.max(start.x, end.x));
  const y2 = clampY(Math.max(start.y, end.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export type PickGesture =
  | { readonly kind: "element"; readonly x: number; readonly y: number }
  | { readonly kind: "region"; readonly rect: PreviewAnnotationRect };

/**
 * A finished pointer gesture in pick mode. A press that barely moved commits
 * the element under it; a drag commits its rect, unless it is too thin to crop.
 */
export function resolvePickGesture(input: {
  readonly startClient: { readonly x: number; readonly y: number };
  readonly endClient: { readonly x: number; readonly y: number };
  readonly startPage: { readonly x: number; readonly y: number };
  readonly endPage: { readonly x: number; readonly y: number };
  readonly page: PageSize;
}): PickGesture | null {
  const moved = Math.hypot(
    input.endClient.x - input.startClient.x,
    input.endClient.y - input.startClient.y,
  );
  if (moved < PICK_DRAG_SLOP_PX) return { kind: "element", ...input.startPage };
  const rect = dragRect(input.startPage, input.endPage, input.page);
  return rect.width >= 1 && rect.height >= 1 ? { kind: "region", rect } : null;
}

/** The rect an annotation marks: its first element, else its first region. */
export function annotationAnchorRect(
  annotation: PreviewAnnotationPayload,
): PreviewAnnotationRect | null {
  const rect = annotation.elements[0]?.rect ?? annotation.regions[0]?.rect ?? null;
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

export interface PickMarker {
  readonly id: string;
  /** 1-based, in the order the annotations were added to the composer. */
  readonly number: number;
  readonly rect: PreviewAnnotationRect;
  /** How many earlier markers share this corner; their badges fan out so none hides another. */
  readonly stack: number;
}

/** Corners this close (page px) count as the same spot. */
const MARKER_SAME_CORNER_PX = 4;

/**
 * Numbered markers for the annotations stacked in the composer that belong to
 * this page. Restored annotations carry no geometry and get no marker, but
 * still count, so a marker's number matches its place in the composer.
 */
export function pickMarkers(
  annotations: ReadonlyArray<PreviewAnnotationPayload>,
  pageUrl: string,
): PickMarker[] {
  if (!pageUrl) return [];
  const markers: PickMarker[] = [];
  annotations.forEach((annotation, index) => {
    if (annotation.pageUrl !== pageUrl) return;
    const rect = annotationAnchorRect(annotation);
    if (!rect) return;
    const stack = markers.filter(
      (marker) =>
        Math.abs(marker.rect.x - rect.x) <= MARKER_SAME_CORNER_PX &&
        Math.abs(marker.rect.y - rect.y) <= MARKER_SAME_CORNER_PX,
    ).length;
    markers.push({ id: annotation.id, number: index + 1, rect, stack });
  });
  return markers;
}

/** The comment popover's submit chord: Cmd/Ctrl+Enter, never mid-composition. */
export function isPickCommentSubmit(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing?: boolean;
}): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.isComposing !== true;
}
