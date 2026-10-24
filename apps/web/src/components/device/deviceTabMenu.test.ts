import type { DeviceHostSummary, DeviceSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";
import { deviceMenuGroups } from "./deviceTabMenu";

const host = (id: string, label: string) =>
  ({
    id,
    label,
    kind: id === "local" ? "local" : "ssh",
    platforms: [],
  }) as unknown as DeviceHostSummary;
const device = (
  hostId: string,
  id: string,
  name: string,
  platform: "ios" | "android",
  booted = false,
): DeviceSummary =>
  ({ hostId, id, name, platform, booted, physical: false, version: "1" }) as DeviceSummary;

describe("deviceMenuGroups", () => {
  it("groups by host in host order, running first, then iOS before Android", () => {
    const groups = deviceMenuGroups(
      {
        hosts: [host("local", "This Mac"), host("lab", "Lab")],
        devices: [
          device("lab", "l1", "Pixel", "android"),
          device("local", "a", "Pixel 9", "android"),
          device("local", "b", "iPhone 16", "ios"),
          device("local", "c", "iPad", "ios", true),
        ],
      },
      [],
    );
    expect(groups.map((group) => group.hostLabel)).toEqual(["This Mac", "Lab"]);
    expect(groups[0]!.entries.map((entry) => entry.device.name)).toEqual([
      "iPad",
      "iPhone 16",
      "Pixel 9",
    ]);
  });

  it("marks devices that already have a tab and skips hosts without devices", () => {
    const surfaces: RightPanelSurface[] = [
      {
        id: "device:local:b",
        kind: "device",
        target: { hostId: "local", deviceId: "b", platform: "ios", name: "iPhone 16" },
      },
    ];
    const groups = deviceMenuGroups(
      {
        hosts: [host("local", "This Mac"), host("empty", "Empty")],
        devices: [
          device("local", "a", "Pixel 9", "android"),
          device("local", "b", "iPhone 16", "ios"),
        ],
      },
      surfaces,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((entry) => [entry.device.id, entry.open])).toEqual([
      ["b", true],
      ["a", false],
    ]);
  });

  it("falls back to the host id when a device's host is not listed", () => {
    const groups = deviceMenuGroups({ hosts: [], devices: [device("gone", "x", "X", "ios")] }, []);
    expect(groups[0]!.hostLabel).toBe("gone");
  });
});
