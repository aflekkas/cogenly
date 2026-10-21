import {
  MARKUP_TEXT_WEIGHT,
  flattenTarget,
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
 * image's own resolution and returns the result as a PNG file.
 */
export async function flattenMarkup(
  original: File,
  name: string,
  shapes: ReadonlyArray<MarkupShape>,
): Promise<File> {
  const bitmap = await createImageBitmap(original);
  try {
    const target = flattenTarget({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.scale(target.scale, target.scale);
    context.drawImage(bitmap, 0, 0);
    drawShapes(context, shapes, markupFontFamily());
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The marked-up image could not be encoded.");
    return new File([blob], markupFileName(name), { type: "image/png" });
  } finally {
    bitmap.close();
  }
}
