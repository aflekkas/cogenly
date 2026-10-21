/**
 * Agents created in this session, so the sidebar can play an enter motion on
 * their row once it first mounts. Nothing on load or on later remounts animates:
 * a row takes its arrival the first time it renders, and that is the only time.
 */
const arrivals = new Set<string>();

export function noteAgentArrival(key: string) {
  arrivals.add(key);
}

/** True once per arrival, for the row that mounts for it. */
export function takeAgentArrival(key: string): boolean {
  return arrivals.delete(key);
}
