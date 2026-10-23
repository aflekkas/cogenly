import type { DeviceHostSummary, DeviceSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildDeviceSetupStatus, unavailablePlatformSteps } from "./DeviceSetupStatus.ts";

const local = (overrides: Partial<DeviceHostSummary> = {}): DeviceHostSummary => ({
  id: "local" as DeviceHostSummary["id"],
  kind: "local",
  label: "This Mac" as DeviceHostSummary["label"],
  platforms: [
    { platform: "ios", available: true },
    { platform: "android", available: false, reason: "Android SDK was not found. Install it." },
  ],
  hubInstalled: true,
  agentDeviceInstalled: true,
  ...overrides,
});

const iphone = {
  hostId: "local",
  id: "A",
  platform: "ios",
  name: "iPhone",
  version: "iOS 18",
  booted: false,
  physical: false,
} as DeviceSummary;

const base = { enabled: true, agentAccessEnabled: true, hostStatuses: {}, devices: [] };

describe("buildDeviceSetupStatus", () => {
  it("is ready when a ready host has a platform with a device, and explains the missing one", () => {
    const status = buildDeviceSetupStatus({
      ...base,
      hosts: [local()],
      hostStatuses: { local: { status: "ready" } },
      devices: [iphone],
    });
    expect(status.ready).toBe(true);
    const [ios, android] = status.hosts[0]!.platforms;
    expect(ios).toMatchObject({ ready: true, deviceCount: 1, nextSteps: [] });
    expect(android).toMatchObject({ available: false, ready: false });
    expect(android!.nextSteps.join(" ")).toContain("Android Studio");
  });

  it("asks for a device_setup call before discovery has run", () => {
    const status = buildDeviceSetupStatus({ ...base, hosts: [local()] });
    expect(status.ready).toBe(false);
    expect(status.hosts[0]!.status).toBe("idle");
    expect(status.hosts[0]!.platforms[0]!.nextSteps[0]).toContain("device_setup");
  });

  it("points at creating a simulator once discovery found none", () => {
    const status = buildDeviceSetupStatus({
      ...base,
      hosts: [local()],
      hostStatuses: { local: { status: "ready" } },
    });
    expect(status.ready).toBe(false);
    expect(status.hosts[0]!.platforms[0]!.nextSteps[0]).toContain("runtime");
  });

  it("reports a failed install with its detail and a retry", () => {
    const status = buildDeviceSetupStatus({
      ...base,
      hosts: [local({ hubInstalled: false })],
      hostStatuses: { local: { status: "failed", detail: "npm exited 1" } },
    });
    expect(status.hosts[0]!.nextSteps.join(" ")).toMatch(/npm exited 1.*device_setup/);
  });

  it("says device support is off instead of reporting hosts as idle", () => {
    const status = buildDeviceSetupStatus({ ...base, enabled: false, hosts: [local()] });
    expect(status.ready).toBe(false);
    expect(status.hosts[0]!.status).toBe("disabled");
    expect(status.nextSteps[0]).toContain("turned off");
  });
});

describe("unavailablePlatformSteps", () => {
  it("sends iOS on a non-macOS host to a Mac host", () => {
    expect(
      unavailablePlatformSteps("ios", "iOS Simulators need macOS with Xcode.", "local")[0],
    ).toContain("device host");
  });

  it("names the SDK Manager for a missing Android component and mentions the restart", () => {
    const steps = unavailablePlatformSteps(
      "android",
      "Android Emulator is missing from /sdk. Install it in Android Studio's SDK Manager.",
      "local",
    );
    expect(steps.join(" ")).toContain("sdkmanager");
    expect(steps.join(" ")).toContain("Restart");
  });
});
