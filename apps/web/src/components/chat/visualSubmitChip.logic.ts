import type { VisualState } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The visual a submitted result came from. The submit turn carries only the
 * title, so the thread's submitted visuals with that title are candidates, and
 * the one submitted closest to the turn wins.
 */
export function submittedVisualRenderId(
  visualStates: ReadonlyArray<Pick<VisualState, "renderId" | "title" | "submittedAt">>,
  title: string | null,
  messageCreatedAt: string,
): string | null {
  const sentAt = Date.parse(messageCreatedAt);
  let best: { readonly renderId: string; readonly distance: number } | null = null;
  for (const visual of visualStates) {
    if (visual.submittedAt === null) continue;
    if (title !== null && visual.title.trim() !== title) continue;
    const distance = Number.isNaN(sentAt)
      ? 0
      : Math.abs(DateTime.toEpochMillis(visual.submittedAt) - sentAt);
    if (best === null || distance < best.distance) best = { renderId: visual.renderId, distance };
  }
  return best?.renderId ?? null;
}

function htmlRenderOf(row: unknown) {
  if (typeof row !== "object" || row === null) return undefined;
  const { kind, htmlRender } = row as { kind?: unknown; htmlRender?: unknown };
  if (kind !== "html-render" || typeof htmlRender !== "object" || htmlRender === null) {
    return undefined;
  }
  const { attachmentId, title } = htmlRender as { attachmentId?: unknown; title?: unknown };
  return typeof attachmentId === "string" && typeof title === "string"
    ? { attachmentId, title }
    : undefined;
}

/**
 * The timeline row index of the visual a result came from: its render by id
 * when the thread's visual states name it, else the latest render with the
 * same title. -1 when the visual is not in the loaded timeline.
 */
export function findVisualRowIndex(
  rows: ReadonlyArray<unknown>,
  renderId: string | null,
  title: string | null,
) {
  if (renderId !== null) {
    const index = rows.findIndex((row) => htmlRenderOf(row)?.attachmentId === renderId);
    if (index !== -1) return index;
  }
  if (title === null) return -1;
  return rows.findLastIndex((row) => htmlRenderOf(row)?.title === title);
}
