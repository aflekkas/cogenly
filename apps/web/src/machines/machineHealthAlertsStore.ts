import type { MachineHealthStatus } from "@cogenly/contracts";
import { create } from "zustand";

/**
 * The worst open machine-health alert across every connected server, or
 * null when none is open. MachineHealthAlertCoordinator writes it; the
 * Settings buttons on the nav rail and in the mobile sheet show a dot from it.
 */
export const useMachineHealthAlertStore = create<{
  worstOpenStatus: MachineHealthStatus | null;
  setWorstOpenStatus: (status: MachineHealthStatus | null) => void;
}>((set) => ({
  worstOpenStatus: null,
  setWorstOpenStatus: (status) =>
    set((state) => (state.worstOpenStatus === status ? state : { worstOpenStatus: status })),
}));

export const MACHINE_NEEDS_ATTENTION_LABEL = "A machine needs attention";

/** The Settings dot's colour, or null while no alert is open. */
export function useMachineHealthAttentionTone(): "destructive" | "warning" | null {
  return useMachineHealthAlertStore((store) => {
    switch (store.worstOpenStatus) {
      case null:
      case "ok":
        return null;
      case "fail":
        return "destructive";
      case "warn":
      case "unknown":
        return "warning";
    }
  });
}
