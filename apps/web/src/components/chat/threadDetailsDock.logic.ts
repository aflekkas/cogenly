import { DETAILS_CARD_CLEARANCE, resolveChatLaneGutter } from "./chatCanvasLayout";

/** The docked details card's width: --thread-details-panel-width (20.25rem) in index.css. */
export const THREAD_DETAILS_DOCK_WIDTH = 20.25 * 16;
/** Its distance from the canvas's right edge (right-3), like the find bar's. */
export const THREAD_DETAILS_DOCK_INSET = 12;

/**
 * Whether thread details can dock beside the chat instead of opening as a
 * popover: only while the right panel is closed, and only when the chat still
 * gets its minimum width (the canvas's own, 40rem) left of the card, after
 * the card's clearance and the lane's gutter. The canvas keeps its width
 * whether the card shows or not, so this never flips because the card opened.
 */
export function canDockThreadDetails(input: {
  readonly canvasWidth: number;
  readonly minChatWidth: number;
  readonly rightPanelOpen: boolean;
}): boolean {
  if (input.rightPanelOpen || input.canvasWidth <= 0) return false;
  const cardLeft = input.canvasWidth - THREAD_DETAILS_DOCK_INSET - THREAD_DETAILS_DOCK_WIDTH;
  const room = cardLeft - DETAILS_CARD_CLEARANCE - resolveChatLaneGutter(input.canvasWidth);
  return room >= input.minChatWidth;
}
