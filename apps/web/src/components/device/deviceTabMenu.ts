import type { DeviceHostId, DeviceServiceState, DeviceSummary } from "@cogenly/contracts";

import type { RightPanelSurface } from "~/rightPanelStore";

/** One simulator or emulator in the "+ → Device" submenu. */
export interface DeviceMenuEntry {
  readonly key: string;
  readonly device: DeviceSummary;
  /** A tab for this device already exists in the thread; selecting it focuses that tab. */
  readonly open: boolean;
}

export interface DeviceMenuGroup {
  readonly hostId: DeviceHostId;
  readonly hostLabel: string;
  readonly entries: readonly DeviceMenuEntry[];
}

export const deviceKey = (device: { readonly hostId: string; readonly id: string }) =>
  `${device.hostId}\u0000${device.id}`;

/**
 * Devices grouped by host, in the order the service lists hosts. Running
 * devices come first, then iOS before Android, then by name. A host with no
 * devices is left out: the submenu lists what can be opened.
 */
export function deviceMenuGroups(
  state: Pick<DeviceServiceState, "hosts" | "devices">,
  surfaces: readonly RightPanelSurface[],
): DeviceMenuGroup[] {
  const openKeys = new Set(
    surfaces.flatMap((surface) =>
      surface.kind === "device" && surface.target
        ? [deviceKey({ hostId: surface.target.hostId, id: surface.target.deviceId })]
        : [],
    ),
  );
  const labels = new Map(state.hosts.map((host) => [host.id, host.label]));
  const hostOrder = [
    ...state.hosts.map((host) => host.id),
    ...state.devices.map((device) => device.hostId),
  ].filter((hostId, index, all) => all.indexOf(hostId) === index);
  return hostOrder.flatMap((hostId) => {
    const entries = state.devices
      .filter((device) => device.hostId === hostId)
      .toSorted(
        (a, b) =>
          Number(b.booted) - Number(a.booted) ||
          (a.platform === b.platform ? 0 : a.platform === "ios" ? -1 : 1) ||
          a.name.localeCompare(b.name),
      )
      .map((device) => ({ key: deviceKey(device), device, open: openKeys.has(deviceKey(device)) }));
    return entries.length === 0
      ? []
      : [{ hostId, hostLabel: labels.get(hostId) ?? hostId, entries }];
  });
}
