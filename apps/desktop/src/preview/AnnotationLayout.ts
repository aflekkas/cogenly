import type { PreviewAnnotationRect } from "@cogenly/contracts";

/** Keeps annotation borders inside the page, including targets larger than the viewport. */
export function annotationBoxInsets(
  rect: PreviewAnnotationRect,
  viewport: { readonly width: number; readonly height: number },
): string | null {
  const inset = 2;
  const left = Math.max(inset, rect.x);
  const top = Math.max(inset, rect.y);
  const right = Math.min(viewport.width - inset, rect.x + rect.width);
  const bottom = Math.min(viewport.height - inset, rect.y + rect.height);
  if (right <= left || bottom <= top) return null;
  return `${top}px ${viewport.width - right}px ${viewport.height - bottom}px ${left}px`;
}
