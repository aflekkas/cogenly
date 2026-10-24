import type { ChatCanvasDetailsCard } from "./chatCanvasLayout";

// Leaves room for the previous-turn button above the first mark.
const CARD_RAIL_GAP = 24;

export function resolveTimelineMinimapClearance({
  rail,
  viewportBottom,
  detailsCard,
}: {
  rail: { left: number; right: number; top: number; height: number };
  viewportBottom: number;
  detailsCard: ChatCanvasDetailsCard | null;
}) {
  if (
    !detailsCard ||
    rail.height <= 0 ||
    detailsCard.left >= rail.right ||
    detailsCard.right <= rail.left ||
    detailsCard.bottom <= rail.top
  ) {
    return { top: 0, height: rail.height };
  }
  const top = detailsCard.bottom + CARD_RAIL_GAP - rail.top;
  return {
    top,
    height: Math.max(1, Math.min(rail.height, viewportBottom - CARD_RAIL_GAP - rail.top - top)),
  };
}
