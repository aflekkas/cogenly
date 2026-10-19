import type { AgentTab } from "./AgentConversation";

/**
 * A tab to show the next time an agent's view mounts or is already showing. Search and
 * other entry points navigate to the agent's conversation thread and ask for a tab here,
 * since the tab is view state rather than part of the route.
 */
const pending = new Map<string, AgentTab>();
const listeners = new Set<(threadKey: string) => void>();

export function requestAgentTab(threadKey: string, tab: AgentTab) {
  pending.set(threadKey, tab);
  for (const listener of listeners) listener(threadKey);
}

export function takeAgentTabRequest(threadKey: string): AgentTab | null {
  const tab = pending.get(threadKey) ?? null;
  pending.delete(threadKey);
  return tab;
}

export function subscribeAgentTabRequests(listener: (threadKey: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
