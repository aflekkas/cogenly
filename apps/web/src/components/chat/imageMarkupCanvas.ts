import {
  MARKUP_TEXT_WEIGHT,
  flattenTarget,
  markupCanvasBounds,
  markupFileName,
  shapeOpacity,
  shapePath,
  textHaloColor,
  textHaloWidth,
  type MarkupShape,
} from "./imageMarkup";

/** The app's sans stack, so flattened text matches the live overlay. */
export function markupFontFamily(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() ||
    "system-ui, sans-serif"
  );
}

/** The app background as a canvas color: the editor's surround, which fills markup drawn past the image. */
export function markupBackgroundColor(): string {
  const probe = document.createElement("span");
  probe.style.background = "var(--background)";
  probe.style.display = "none";
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color && color !== "rgba(0, 0, 0, 0)" ? color : "#0d0d0f";
}

function drawShapes(
  context: CanvasRenderingContext2D,
  shapes: ReadonlyArray<MarkupShape>,
  fontFamily: string,
) {
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const shape of shapes) {
    context.save();
    context.globalAlpha = shapeOpacity(shape);
    if (shape.kind === "text") {
      context.font = `${MARKUP_TEXT_WEIGHT} ${shape.width}px ${fontFamily}`;
      context.textBaseline = "top";
      context.lineWidth = textHaloWidth(shape.width);
      context.strokeStyle = textHaloColor(shape.color);
      context.strokeText(shape.text, shape.at.x, shape.at.y);
      context.fillStyle = shape.color;
      context.fillText(shape.text, shape.at.x, shape.at.y);
    } else {
      context.lineWidth = shape.width;
      context.strokeStyle = shape.color;
      context.stroke(new Path2D(shapePath(shape)));
    }
    context.restore();
  }
}

/**
 * Draws the shapes onto the original image on an offscreen canvas at the
 * image's own resolution and returns the result as a PNG file. Markup drawn
 * past the image's edges grows the canvas to hold it; the added area is
 * filled with `background`, the color the editor showed around the image.
 */
export async function flattenMarkup(
  original: File,
  name: string,
  shapes: ReadonlyArray<MarkupShape>,
  background: string,
): Promise<File> {
  const bitmap = await createImageBitmap(original);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    const fontFamily = markupFontFamily();
    const bounds = markupCanvasBounds(
      { width: bitmap.width, height: bitmap.height },
      shapes,
      (text, fontSize) => {
        context.font = `${MARKUP_TEXT_WEIGHT} ${fontSize}px ${fontFamily}`;
        return context.measureText(text).width;
      },
    );
    const target = flattenTarget(bounds);
    // Resizing resets the context, so the measuring font above does not carry over.
    canvas.width = target.width;
    canvas.height = target.height;
    context.scale(target.scale, target.scale);
    context.translate(-bounds.x, -bounds.y);
    context.fillStyle = background;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.drawImage(bitmap, 0, 0);
    drawShapes(context, shapes, fontFamily);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The marked-up image could not be encoded.");
    return new File([blob], markupFileName(name), { type: "image/png" });
  } finally {
    bitmap.close();
  }
}
