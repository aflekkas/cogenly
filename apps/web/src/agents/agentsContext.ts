import { createContext, type Context } from "react";
import type { AgentConversationData, AgentsClient } from "./agentsClient";

/**
 * The agents contexts, kept apart from `agentsClient.tsx` so a hot update there
 * does not mint new context objects: the provider and its already-mounted
 * consumers would then disagree and every consumer would read null. A hot update
 * of this file reuses the objects from `import.meta.hot.data` for the same reason.
 */
const hotData: {
  clientContext?: Context<AgentsClient | null>;
  hydrationContext?: Context<((key: string, content: AgentConversationData) => void) | null>;
} = import.meta.hot?.data ?? {};

export const AgentsClientContext = (hotData.clientContext ??= createContext<AgentsClient | null>(
  null,
));

export const AgentHydrationContext = (hotData.hydrationContext ??= createContext<
  ((key: string, content: AgentConversationData) => void) | null
>(null));
