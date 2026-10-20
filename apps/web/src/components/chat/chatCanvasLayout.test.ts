import { describe, expect, it } from "vite-plus/test";

import {
  DETAILS_CARD_CLEARANCE,
  MINIMAP_RAIL_WIDTH,
  resolveChatCanvasLayout,
} from "./chatCanvasLayout";

const base = { preview: null, padding: 48, maxChatWidth: 853, minChatWidth: 640 } as const;
const container = { width: 1511, height: 1000 };
const source = { width: 1280, height: 800 };

describe("resolveChatCanvasLayout", () => {
  it("centers chat in the pane without the details card", () => {
    const { chat } = resolveChatCanvasLayout({ ...base, container });
    expect(chat.width).toBe(853);
    expect(chat.left).toBe((1511 - 853) / 2);
  });

  it("centers chat in the space left of an open details card", () => {
    // The reference at 2000px: pane 1511 wide, card at 1173, composer at 112.
    const { chat } = resolveChatCanvasLayout({
      ...base,
      container,
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

  it("never moves chat for the floating preview, wherever it sits", () => {
    const without = resolveChatCanvasLayout({ ...base, container });
    for (const position of [null, { x: 48, y: 400 }, { x: 600, y: 100 }, { x: 1200, y: 700 }]) {
      const { chat } = resolveChatCanvasLayout({
        ...base,
        container,
        composerHeight: 120,
        preview: { key: "tab", width: 420, position, source, lastInteraction: "drag" },
      });
      expect(chat).toEqual(without.chat);
    }
  });

  it("docks a new player bottom right, inside the minimap rail and above the composer", () => {
    const { chat, frame } = resolveChatCanvasLayout({
      ...base,
      container,
      composerHeight: 120,
      preview: { key: "tab", width: 420, position: null, source },
    });
    expect(frame).not.toBeNull();
    expect(frame!.x + frame!.width).toBe(container.width - MINIMAP_RAIL_WIDTH - 12);
    // It would cover the composer's right end, so it lifts above the composer.
    expect(frame!.x).toBeLessThan(chat.left + chat.width);
    expect(frame!.y + frame!.height).toBe(container.height - 120 - 12);
  });

  it("keeps a dragged player where it was dropped, clamped to the pane", () => {
    const { frame } = resolveChatCanvasLayout({
      ...base,
      container,
      composerHeight: 120,
      preview: { key: "tab", width: 420, position: { x: 500, y: 2000 }, source },
    });
    expect(frame!.x).toBe(500);
    expect(frame!.y + frame!.height).toBe(container.height - 12);
  });
});
