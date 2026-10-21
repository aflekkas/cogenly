import { useSyncExternalStore } from "react";

/** The Agents column's filter: every agent, or only those waiting on you. */
export type AgentListFilter = "all" | "attention";

let filter: AgentListFilter = "all";
const listeners = new Set<() => void>();

export function setAgentListFilter(next: AgentListFilter) {
  if (filter === next) return;
  filter = next;
  for (const listener of listeners) listener();
}

export function useAgentListFilter(): AgentListFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => filter,
  );
}
