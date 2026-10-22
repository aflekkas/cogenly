/** Where the workspace card sits in the canvas: its left and right edges, and its bottom. */
export interface ChatCanvasDetailsCard {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

// Minimum space between chat and the workspace card. Chat stays centered while
// the card fits beside it with this much room.
export const DETAILS_CARD_CLEARANCE = 32;
// With the card open, chat centers in the space left of it, less this much:
// the reference layout's offset, measured at a 2000px window.
const DETAILS_CARD_CENTERING_OFFSET = 96;

/**
 * Pure geometry shared by the conversation, composer, and workspace card. Only
 * the workspace card moves the chat lane.
 */
export function resolveChatCanvasLayout({
  container,
  padding = 48,
  maxChatWidth = 768,
  detailsCard = null,
}: {
  container: { readonly width: number; readonly height: number };
  padding?: number;
  maxChatWidth?: number;
  detailsCard?: ChatCanvasDetailsCard | null;
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  // With the workspace card open, chat centers in the space left of it, and
  // never comes closer to the card than the clearance. Chat narrows only after
  // it reaches the left padding.
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const centeredLeft = detailsCard
    ? (detailsCard.left - DETAILS_CARD_CENTERING_OFFSET - normalWidth) / 2
    : (container.width - normalWidth) / 2;
  const normalLeft = Math.max(padding, Math.min(centeredLeft, laneRight - normalWidth));
  const chat = {
    left: normalLeft,
    width: normalWidth,
    insetStart: 0,
    insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth),
  };
  return { chat };
}
