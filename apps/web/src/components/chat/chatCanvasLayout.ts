import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
  resolvePreviewMiniPlayerFrame,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
  type PreviewMiniPlayerSourceShape,
} from "../preview/previewMiniPlayerLayout";
import type {
  PreviewMiniPlayerPosition,
  PreviewMiniPlayerSize,
  PreviewMiniPlayerState,
} from "~/previewMiniPlayerStore";

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSourceShape;
  readonly lastInteraction?: PreviewMiniPlayerState["lastInteraction"];
}

const GAP = PREVIEW_MINI_PLAYER_EDGE_GAP;
// Minimum space between chat and the workspace card. Chat stays centered while
// the card fits beside it with this much room.
export const DETAILS_CARD_CLEARANCE = 32;
// With the card open, chat centers in the space left of it, less this much:
// the reference layout's offset, measured at a 2000px window.
const DETAILS_CARD_CENTERING_OFFSET = 96;
// The transcript's minimap rail (MessagesTimeline, w-18) sits on the pane's
// right edge; a freshly floated player docks inside it.
export const MINIMAP_RAIL_WIDTH = 72;

/**
 * Pure geometry shared by the conversation, composer, workspace card, and
 * floating preview. The floating preview is a true picture-in-picture: it
 * floats over chat and never moves the transcript or composer. Only the
 * workspace card moves the chat lane.
 */
export function resolveChatCanvasLayout({
  container,
  preview,
  padding = 48,
  maxChatWidth = 768,
  minChatWidth: _minChatWidth = 640,
  composerHeight = 0,
  detailsCard = null,
  findBar = null,
}: {
  container: PreviewMiniPlayerSize;
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: PreviewMiniPlayerObstacles["detailsCard"];
  /** The open find bar. It only keeps the floating preview clear; chat stays put. */
  findBar?: PreviewMiniPlayerObstacles["detailsCard"];
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
  let frame: PreviewMiniPlayerFrame | null = null;
  if (preview && container.width > 0 && container.height > 0) {
    // Sized for the container; a stored position is only kept on screen.
    const sized = resolvePreviewMiniPlayerFrame({ ...preview, container });
    if (preview.position !== null) {
      frame = sized;
    } else {
      // A new player docks at the bottom right, inside the minimap rail, and
      // above the composer where it would cover it. The card and find bar
      // are docked to the top, so they only matter when the pane is short.
      const x = Math.max(GAP, container.width - MINIMAP_RAIL_WIDTH - GAP - sized.width);
      const overComposer =
        composerHeight > 0 && x < chat.left + chat.width + GAP && x + sized.width > chat.left - GAP;
      const y = container.height - GAP - sized.height - (overComposer ? composerHeight : 0);
      const topObstacle =
        detailsCard && findBar
          ? {
              left: Math.min(detailsCard.left, findBar.left),
              right: Math.max(detailsCard.right, findBar.right),
              bottom: Math.max(detailsCard.bottom, findBar.bottom),
            }
          : (detailsCard ?? findBar);
      frame = {
        ...sized,
        ...clampPreviewMiniPlayerPosition({ x, y }, container, sized, {
          detailsCard: topObstacle,
          composer: null,
        }),
      };
    }
  }
  const overlapsDetailsCard = Boolean(
    frame &&
    detailsCard &&
    frame.x < detailsCard.right &&
    frame.x + frame.width > detailsCard.left &&
    frame.y < detailsCard.bottom,
  );
  return { chat, frame, overlapsDetailsCard };
}
