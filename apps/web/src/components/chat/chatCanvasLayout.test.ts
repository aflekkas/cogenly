import { describe, expect, it } from "vite-plus/test";

import { DETAILS_CARD_CLEARANCE, resolveChatCanvasLayout } from "./chatCanvasLayout";

const base = { preview: null, padding: 48, maxChatWidth: 853, minChatWidth: 640 } as const;

describe("resolveChatCanvasLayout", () => {
  it("centers chat in the pane without the details card", () => {
    const { chat } = resolveChatCanvasLayout({ ...base, container: { width: 1511, height: 1000 } });
    expect(chat.width).toBe(853);
    expect(chat.left).toBe((1511 - 853) / 2);
  });

  it("centers chat in the space left of an open details card", () => {
    // The reference at 2000px: pane 1511 wide, card at 1173, composer at 112.
    const { chat } = resolveChatCanvasLayout({
      ...base,
      container: { width: 1511, height: 1000 },
      detailsCard: { left: 1173, right: 1498, bottom: 265 },
    });
    expect(chat.width).toBe(853);
    expect(chat.left).toBe(112);
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
