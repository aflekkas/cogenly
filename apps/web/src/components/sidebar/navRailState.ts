import { create } from "zustand";

/**
 * Live counts the navigation rail shows but does not compute. The thread
 * sidebar owns the agent state and reports here; the rail outlives it on
 * Settings, where the last reported count stays.
 */
export const useNavRailBadgeStore = create<{
  agentsNeedingYou: number;
  setAgentsNeedingYou: (count: number) => void;
}>((set) => ({
  agentsNeedingYou: 0,
  setAgentsNeedingYou: (count) =>
    set((state) => (state.agentsNeedingYou === count ? state : { agentsNeedingYou: count })),
}));
