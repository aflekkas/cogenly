import { describe, expect, it } from "vite-plus/test";

import {
  DETAILS_CARD_CLEARANCE,
  resolveChatCanvasLayout,
  resolveChatLaneGutter,
} from "./chatCanvasLayout";

const base = { padding: 48, maxChatWidth: 853 } as const;
const container = { width: 1511, height: 1000 };

describe("resolveChatCanvasLayout", () => {
  it("centers chat in the pane without the details card", () => {
    const { chat } = resolveChatCanvasLayout({ ...base, container });
    expect(chat.width).toBe(853);
    expect(chat.left).toBe((1511 - 853) / 2);
  });

  it("centers chat in the space left of an open details card, equal gaps on both sides", () => {
    const card = { left: 1173, right: 1498, bottom: 265 };
    const { chat } = resolveChatCanvasLayout({ ...base, container, detailsCard: card });
    expect(chat.width).toBe(853);
    expect(chat.left).toBe(160);
    expect(card.left - (chat.left + chat.width)).toBe(chat.left);
  });

  it("keeps the clearance from the card, then narrows at the left padding", () => {
    const card = { left: 760, right: 1084, bottom: 265 };
    const { chat } = resolveChatCanvasLayout({
      ...base,
      container: { width: 1084, height: 1000 },
      detailsCard: card,
    });
    expect(chat.left).toBe(48);
    expect(chat.left + chat.width).toBeLessThanOrEqual(card.left - DETAILS_CARD_CLEARANCE);
  });
});

describe("resolveChatLaneGutter", () => {
  it("keeps tight gutters in a narrow chat column", () => {
    expect(resolveChatLaneGutter(0)).toBe(12);
    expect(resolveChatLaneGutter(480)).toBe(12);
    expect(resolveChatLaneGutter(640)).toBe(16);
  });

  it("ramps to the wide gutter and holds it", () => {
    expect(resolveChatLaneGutter(760)).toBe(32);
    expect(resolveChatLaneGutter(880)).toBe(48);
    expect(resolveChatLaneGutter(1511)).toBe(48);
  });

  it("never shrinks as the column widens", () => {
    let previous = 0;
    for (let width = 0; width <= 1200; width += 7) {
      const gutter = resolveChatLaneGutter(width);
      expect(gutter).toBeGreaterThanOrEqual(previous);
      previous = gutter;
    }
  });
});
