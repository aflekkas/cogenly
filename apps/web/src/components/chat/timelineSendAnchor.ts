import type { MessageId } from "@t3tools/contracts";

import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";

/**
 * A sent message's framing, like ChatGPT and Claude.ai: the message rises to the
 * top of the viewport, just below the floating header, and its reply streams in
 * underneath. Bottom space reserved under the turn (the anchored end space)
 * lets the message reach the top while the reply is still short; it shrinks as
 * the reply grows and is gone once the turn fills the viewport, from which point
 * the timeline stops following and the scroll-to-end pill takes over.
 */

/**
 * The anchored message's distance from the scroller's top edge: below the
 * header inset (the transcript scrolls under the chat header), at the same gap
 * a thread's first row has, so the first send of a new chat does not move.
 */
export function sendAnchorOffset(headerInset: number): number {
  return Math.max(0, headerInset) + CHAT_TIMELINE_ANCHOR_OFFSET;
}

/** The row to anchor for a sent message, wherever it sits in the thread. */
export function resolveSendAnchorEndSpace<Row>(
  rows: ReadonlyArray<Row>,
  anchorMessageId: MessageId | null,
  getUserMessageId: (row: Row) => MessageId | null,
  anchorOffset: number,
): { readonly anchorIndex: number; readonly anchorOffset: number } | undefined {
  if (anchorMessageId === null) return undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && getUserMessageId(row) === anchorMessageId) {
      return { anchorIndex: index, anchorOffset };
    }
  }
  return undefined;
}

/**
 * The space reserved under an anchored turn, as LegendList's anchored end space
 * sizes it: whatever keeps the turn's rows (and the footer holding the composer
 * inset) plus the space a viewport tall below the anchor offset, so the sent
 * message can scroll to the top. Zero once the turn alone is that tall, which is
 * where the timeline stops following.
 */
export function anchoredEndSpaceSize(input: {
  readonly viewportHeight: number;
  readonly turnHeight: number;
  readonly anchorOffset: number;
}): number {
  return Math.max(0, input.viewportHeight - input.turnHeight - input.anchorOffset);
}

/**
 * The scroll offset that puts the anchored row `anchorOffset` below the top,
 * clamped to the list's range.
 */
export function anchoredScrollTarget(input: {
  readonly anchorTop: number;
  readonly anchorOffset: number;
  readonly maxScroll: number;
}): number {
  return Math.max(0, Math.min(input.anchorTop - input.anchorOffset, Math.max(0, input.maxScroll)));
}
