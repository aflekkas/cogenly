import { create } from "zustand";

/**
 * Live counts the navigation rail shows but does not compute. The thread
 * sidebar owns the agent state and reports here; the rail outlives it on
 * Settings, where the last reported count stays.
 */
export const useNavRailBadgeStore = create<{
  decisionsWaiting: number;
  setDecisionsWaiting: (count: number) => void;
}>((set) => ({
  decisionsWaiting: 0,
  setDecisionsWaiting: (count) =>
    set((state) => (state.decisionsWaiting === count ? state : { decisionsWaiting: count })),
}));
