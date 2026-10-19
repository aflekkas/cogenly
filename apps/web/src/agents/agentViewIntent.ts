import { create } from "zustand";
import { agentContactKey } from "./agents.logic";
import type { AgentContact } from "./agents.types";

/**
 * What to show when an agent's view opens: its Open items tab or the Start Work
 * dialog. The command palette sets it, then navigates to the agent's conversation;
 * the view takes it once, whether it mounts afterwards or is already open.
 */
interface AgentViewIntent {
  key: string;
  view: "items" | "start-work";
}

const useAgentViewIntentStore = create<{ intent: AgentViewIntent | null }>(() => ({
  intent: null,
}));

export function requestAgentView(
  agent: Pick<AgentContact, "environmentId" | "id">,
  view: AgentViewIntent["view"],
) {
  useAgentViewIntentStore.setState({ intent: { key: agentContactKey(agent), view } });
}

/** Calls `apply` with a pending and every later request for this agent; returns the unsubscribe. */
export function watchAgentViewIntent(key: string, apply: (view: AgentViewIntent["view"]) => void) {
  const take = (intent: AgentViewIntent | null) => {
    if (intent?.key !== key) return;
    useAgentViewIntentStore.setState({ intent: null });
    apply(intent.view);
  };
  take(useAgentViewIntentStore.getState().intent);
  return useAgentViewIntentStore.subscribe((state) => take(state.intent));
}
