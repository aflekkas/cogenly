export type AgentTab = "chat" | "activity" | "items" | "responsibilities";
export type AgentView = AgentTab | "start-work";

/**
 * What to show the next time an agent's view mounts or while it is already showing: a tab,
 * or the Start Work dialog. The command palette and search ask here, then navigate to the
 * agent's conversation thread, since the tab is view state rather than part of the route.
 * Only the latest request is kept, so one that never reaches its view can't fire later.
 */
let pending: { key: string; view: AgentView } | null = null;
const listeners = new Set<() => void>();

/** Requests are keyed by the agent's conversation thread, the route an agent view lives on. */
export const agentViewKey = (agent: { environmentId: string; conversationThreadId: string }) =>
  `${agent.environmentId}:${agent.conversationThreadId}`;

export function requestAgentView(key: string, view: AgentView) {
  pending = { key, view };
  for (const listener of listeners) listener();
}

/** Takes a pending request for this view, so it applies once. */
export function takeAgentView(key: string): AgentView | null {
  if (pending?.key !== key) return null;
  const { view } = pending;
  pending = null;
  return view;
}

/** Calls `apply` with every later request for this view; returns the unsubscribe. */
export function watchAgentView(key: string, apply: (view: AgentView) => void) {
  const listener = () => {
    const view = takeAgentView(key);
    if (view) apply(view);
  };
  listeners.add(listener);
  // A request made between the first render and this subscription still applies.
  listener();
  return () => {
    listeners.delete(listener);
  };
}
