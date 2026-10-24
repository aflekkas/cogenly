import { createContext, useContext } from "react";
import type { ChatCanvasDetailsCard, resolveChatCanvasLayout } from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  /** The docked details card while it is open; floating cards keep clear of it. */
  detailsCard: ChatCanvasDetailsCard | null;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: ChatCanvasDetailsCard | null) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
