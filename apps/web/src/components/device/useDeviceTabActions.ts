import type { DeviceServiceState, DeviceSummary, ScopedThreadRef } from "@cogenly/contracts";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import { useMemo } from "react";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { deviceKey, deviceMenuGroups, type DeviceMenuEntry } from "./deviceTabMenu";

/**
 * Devices whose session is being opened (and booted, when stopped). The "+"
 * menu opens the tab first and the open request outlives it, so the panel
 * reads this to show a loading view instead of the device picker.
 */
const useDeviceOpenPendingStore = create<{ readonly keys: Readonly<Record<string, true>> }>(() => ({
  keys: {},
}));

const pendingKey = (environmentId: string, device: { hostId: string; id: string }) =>
  `${environmentId}\u0000${deviceKey(device)}`;

export function useDeviceOpenPending(
  environmentId: string,
  device: { hostId: string; id: string } | null,
): boolean {
  return useDeviceOpenPendingStore((state) =>
    device ? pendingKey(environmentId, device) in state.keys : false,
  );
}

function setPending(key: string, pending: boolean) {
  useDeviceOpenPendingStore.setState((state) => {
    if (pending === key in state.keys) return state;
    const { [key]: _removed, ...rest } = state.keys;
    return { keys: pending ? { ...state.keys, [key]: true as const } : rest };
  });
}

/** What the "+ → Device" submenu renders and calls. */
export interface DeviceAddMenu {
  readonly groups: ReturnType<typeof deviceMenuGroups>;
  /** Install and discovery are still running, so an empty list is not final. */
  readonly busy: boolean;
  readonly onSelectDevice: (entry: DeviceMenuEntry) => void;
  /** Refreshes the list; the first call also installs device support. */
  readonly onOpen: () => void;
}

/**
 * Opens a device as a right-panel tab. The tab appears at once and the session
 * request follows, so a stopped simulator shows a starting view in its own tab
 * rather than leaving the menu looking inert. A device that already has a tab is
 * focused instead of duplicated; its session is only requested again when the
 * server no longer has one.
 */
export function useDeviceTabActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly state: DeviceServiceState;
  readonly surfaces: readonly RightPanelSurface[];
}): DeviceAddMenu {
  const { threadRef, state, surfaces } = input;
  const open = useAtomCommand(deviceEnvironment.open, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const groups = useMemo(() => deviceMenuGroups(state, surfaces), [state, surfaces]);
  const busy = [
    state.hostStatus,
    ...Object.values(state.hostStatuses).map((host) => host.status),
  ].some((status) => status === "installing" || status === "starting");

  const requestSession = async (device: DeviceSummary) => {
    if (!threadRef) return null;
    const key = pendingKey(threadRef.environmentId, device);
    setPending(key, true);
    try {
      return await open({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          hostId: device.hostId,
          deviceId: device.id,
          platform: device.platform,
        },
      });
    } finally {
      setPending(key, false);
    }
  };

  return {
    groups,
    busy,
    onOpen: () => {
      if (!threadRef) return;
      void list({ environmentId: threadRef.environmentId, input: {} });
    },
    onSelectDevice: (entry) => {
      if (!threadRef) return;
      const { device } = entry;
      const store = useRightPanelStore.getState();
      const hasSession = state.sessions.some(
        (session) =>
          session.threadId === threadRef.threadId &&
          session.hostId === device.hostId &&
          session.deviceId === device.id,
      );
      store.openDevice(threadRef, {
        hostId: device.hostId,
        deviceId: device.id,
        platform: device.platform,
        name: device.name,
      });
      if (hasSession) return;
      void requestSession(device).then((result) => {
        if (!result || result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const surfaceId = `device:${encodeURIComponent(device.hostId)}:${encodeURIComponent(device.id)}`;
        useRightPanelStore.getState().closeSurface(threadRef, surfaceId);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Unable to open ${device.name}`,
            description: formatEnvironmentQueryError(result.cause),
          }),
        );
      });
    },
  };
}
