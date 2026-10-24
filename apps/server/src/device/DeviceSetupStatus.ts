/**
 * The setup report behind `device_setup_status` and `device_setup`: what is
 * installed on each host, why a platform is missing, and what to do about it.
 * Built from state the service already holds, so reading it never installs or
 * starts anything.
 */
import type {
  DeviceHostSummary,
  DevicePlatform,
  DeviceServiceState,
  DeviceSetupHostStatus,
  DeviceSetupPlatformStatus,
  DeviceSetupStatus,
  DeviceSummary,
} from "@t3tools/contracts";

const RETRY = "Call device_setup to re-check.";
const RESTART_SERVER =
  "Restart the Cogenly server afterwards: it detects the Android SDK when it starts.";

/**
 * Steps for a platform the host cannot run. Keyed on the reason text the
 * hosts report (LocalDeviceHost.platformReason, sshDeviceScript) so the agent
 * gets a fix rather than the diagnosis alone; an unrecognised reason still
 * comes back verbatim in `reason`.
 */
export function unavailablePlatformSteps(
  platform: DevicePlatform,
  reason: string,
  hostKind: "local" | "ssh",
): ReadonlyArray<string> {
  const where = hostKind === "ssh" ? " on that host" : "";
  if (/cannot reach device host/i.test(reason)) {
    return ["Test the host's SSH connection in Settings → Integrations → Devices → Device hosts."];
  }
  if (platform === "ios") {
    if (/need macOS/i.test(reason)) {
      return [
        "iOS Simulators only run on macOS. Add a Mac as a device host in Settings → Integrations → Devices → Device hosts, or use Android here.",
      ];
    }
    return [
      `Needs the user: install Xcode${where} from the App Store, then run \`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\` and \`sudo xcodebuild -runFirstLaunch\`. \`xcode-select --install\` alone only installs command line tools, which is not enough for simulators.`,
      RETRY,
    ];
  }
  if (/sdk was not found|android sdk missing/i.test(reason)) {
    return [
      `Needs the user: install Android Studio${where} (macOS: \`brew install --cask android-studio\`), open it once so it downloads the SDK, or set ANDROID_HOME to an existing SDK directory.`,
      RESTART_SERVER,
      RETRY,
    ];
  }
  if (/older, unsupported|command-line tools/i.test(reason)) {
    return [
      'Install "Android SDK Command-line Tools (latest)" in Android Studio → SDK Manager → SDK Tools, or run `sdkmanager "cmdline-tools;latest"` from an existing command-line tools install.',
      RESTART_SERVER,
      RETRY,
    ];
  }
  return [
    'Install the missing SDK component in Android Studio → SDK Manager → SDK Tools, or run `sdkmanager "platform-tools" "emulator" "cmdline-tools;latest"`.',
    RESTART_SERVER,
    RETRY,
  ];
}

function noDeviceSteps(platform: DevicePlatform): ReadonlyArray<string> {
  return platform === "ios"
    ? [
        "No iOS Simulator exists. Needs the user: install a runtime in Xcode → Settings → Components, or run `xcrun simctl list devices available` to check what is installed.",
        RETRY,
      ]
    : [
        "No Android virtual device exists. Needs the user: create one in Android Studio → Device Manager, or run `avdmanager create avd` (system image required).",
        RETRY,
      ];
}

function platformStatus(
  host: DeviceHostSummary,
  platform: DeviceHostSummary["platforms"][number],
  devices: ReadonlyArray<DeviceSummary>,
  discovered: boolean,
): DeviceSetupPlatformStatus {
  const deviceCount = devices.filter(
    (device) => device.hostId === host.id && device.platform === platform.platform,
  ).length;
  const base = {
    platform: platform.platform,
    available: platform.available,
    deviceCount,
    ready: platform.available && deviceCount > 0,
  };
  if (!platform.available) {
    const reason = platform.reason ?? "Platform toolchain missing.";
    return {
      ...base,
      reason,
      nextSteps: unavailablePlatformSteps(platform.platform, reason, host.kind),
    };
  }
  if (deviceCount === 0) {
    return discovered
      ? { ...base, nextSteps: noDeviceSteps(platform.platform) }
      : { ...base, nextSteps: ["Devices have not been discovered yet. Call device_setup."] };
  }
  return { ...base, nextSteps: [] };
}

function hostStatus(input: {
  readonly enabled: boolean;
  readonly host: DeviceHostSummary;
  readonly status: DeviceServiceState["hostStatuses"][string] | undefined;
  readonly devices: ReadonlyArray<DeviceSummary>;
}): DeviceSetupHostStatus {
  const { host } = input;
  const status = input.status?.status ?? (input.enabled ? "idle" : "disabled");
  const discovered = status === "ready";
  const platforms = host.platforms.map((platform) =>
    platformStatus(host, platform, input.devices, discovered),
  );
  const nextSteps: string[] = [];
  if (status === "failed") {
    nextSteps.push(
      `Device support failed to start${input.status?.detail ? `: ${input.status.detail}` : "."} Call device_setup to retry. If it keeps failing, check network access and that Node 22+ and npm work${host.kind === "ssh" ? " in a non-interactive SSH session on that host" : ""}.`,
    );
  } else if (
    input.enabled &&
    !host.hubInstalled &&
    platforms.some((platform) => platform.available)
  ) {
    nextSteps.push(
      "The device hub is not installed yet. It installs the first time a device is opened; call device_setup to install it now.",
    );
  }
  return {
    hostId: host.id,
    label: host.label,
    kind: host.kind,
    status,
    ...(input.status?.detail ? { detail: input.status.detail } : {}),
    hubInstalled: host.hubInstalled,
    agentDeviceInstalled: host.agentDeviceInstalled,
    platforms,
    nextSteps,
  };
}

export function buildDeviceSetupStatus(input: {
  readonly enabled: boolean;
  readonly agentAccessEnabled: boolean;
  readonly hosts: ReadonlyArray<DeviceHostSummary>;
  readonly hostStatuses: DeviceServiceState["hostStatuses"];
  readonly devices: ReadonlyArray<DeviceSummary>;
}): DeviceSetupStatus {
  const hosts = input.hosts.map((host) =>
    hostStatus({
      enabled: input.enabled,
      host,
      status: input.hostStatuses[host.id],
      devices: input.devices,
    }),
  );
  const nextSteps: string[] = [];
  if (!input.enabled) {
    nextSteps.push(
      "Device support is turned off. Ask the user to turn it on in Settings → Integrations → Devices, or call device_setup with enableDeviceSupport=true if they asked you to set devices up.",
    );
  }
  const ready =
    input.enabled &&
    hosts.some((host) => host.status === "ready" && host.platforms.some((p) => p.ready));
  if (input.enabled && !ready) {
    const usable = hosts.filter((host) => host.platforms.some((platform) => platform.available));
    if (usable.length === 0 && hosts.length > 0) {
      nextSteps.push(
        "No host can run a simulator or emulator yet. Fix at least one platform below; either is enough.",
      );
    }
  }
  return {
    enabled: input.enabled,
    agentAccessEnabled: input.agentAccessEnabled,
    ready,
    hosts,
    nextSteps,
  };
}
