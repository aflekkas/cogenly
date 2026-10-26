import { useMemo } from "react";
import { create } from "zustand";

import {
  settingsAttentionByPage,
  worstAttentionTone,
  type SettingsAttentionAlert,
  type SettingsAttentionTone,
} from "../components/settings/settingsAttention.logic";
import type { SettingsPath } from "../components/settings/settingsSearch";

const NO_ALERTS: ReadonlyArray<SettingsAttentionAlert> = [];

/** Same alerts, same order: a fresh snapshot of unchanged alerts keeps the old list. */
function sameAlerts(
  left: ReadonlyArray<SettingsAttentionAlert>,
  right: ReadonlyArray<SettingsAttentionAlert>,
): boolean {
  return (
    left.length === right.length &&
    left.every((alert, index) => {
      const other = right[index]!;
      return (
        alert.originEnvironmentId === other.originEnvironmentId &&
        alert.checkId === other.checkId &&
        alert.status === other.status &&
        JSON.stringify(alert.target) === JSON.stringify(other.target)
      );
    })
  );
}

/**
 * Every open machine-health alert across every connected server, deduped.
 * MachineHealthAlertCoordinator writes it; the Settings buttons on the nav
 * rail and in the mobile sheet, the settings nav and the rows an alert
 * concerns all show their dots from it, so they clear together.
 */
export const useMachineHealthAlertStore = create<{
  openAlerts: ReadonlyArray<SettingsAttentionAlert>;
  setOpenAlerts: (alerts: ReadonlyArray<SettingsAttentionAlert>) => void;
}>((set) => ({
  openAlerts: NO_ALERTS,
  setOpenAlerts: (alerts) =>
    set((state) =>
      sameAlerts(state.openAlerts, alerts)
        ? state
        : { openAlerts: alerts.length === 0 ? NO_ALERTS : alerts },
    ),
}));

export const MACHINE_NEEDS_ATTENTION_LABEL = "A machine needs attention";

/** The open alerts, for a page's own row dots. */
export function useOpenMachineHealthAlerts(): ReadonlyArray<SettingsAttentionAlert> {
  return useMachineHealthAlertStore((store) => store.openAlerts);
}

/** The Settings dot's colour, or null while no alert is open. */
export function useMachineHealthAttentionTone(): SettingsAttentionTone | null {
  return useMachineHealthAlertStore((store) => worstAttentionTone(store.openAlerts));
}

/** Each settings page's dot, for the settings nav. */
export function useSettingsAttentionByPage(): ReadonlyMap<SettingsPath, SettingsAttentionTone> {
  const alerts = useOpenMachineHealthAlerts();
  return useMemo(() => settingsAttentionByPage(alerts), [alerts]);
}
