/**
 * The report behind `computer_status`, the Settings row and the thread prompt:
 * whether agents can drive this machine's apps, and if not, exactly what is
 * missing. Pure, so the permission state machine is tested with fake probes.
 */
import {
  COMPUTER_USE_PERMISSION_SETTINGS_URLS,
  COMPUTER_USE_PERMISSION_TITLES,
  COMPUTER_USE_PERMISSIONS,
  type ComputerUsePermission,
  type ComputerUsePermissionGrant,
  type ComputerUseStatus,
} from "@cogenly/contracts";

/** What one probe of the OS saw. `null` when the probe itself could not run. */
export interface ComputerUseProbe {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  /** Displays in the logged-in desktop session; 0 when there is none to drive. */
  readonly displays: number;
}

const NEEDED_FOR: Record<ComputerUsePermission, string> = {
  accessibility: "clicking, typing and reading other apps' controls",
  "screen-recording": "taking screenshots of the screen",
};

/** Which grant each tool needs before it can run. Status and app listing need none. */
export const COMPUTER_TOOL_PERMISSION: Record<string, ComputerUsePermission | undefined> = {
  computer_status: undefined,
  computer_apps: undefined,
  computer_open_app: undefined,
  computer_screenshot: "screen-recording",
  computer_ui: "accessibility",
  computer_press: "accessibility",
  computer_click: "accessibility",
  computer_type: "accessibility",
  computer_key: "accessibility",
  computer_scroll: "accessibility",
  computer_drag: "accessibility",
};

const grantOf = (
  probe: ComputerUseProbe | null,
  permission: ComputerUsePermission,
): ComputerUsePermissionGrant =>
  probe === null
    ? "unknown"
    : (permission === "accessibility" ? probe.accessibility : probe.screenRecording)
      ? "granted"
      : "missing";

export function unsupportedReason(platform: string): string | undefined {
  if (platform === "darwin") return undefined;
  const where = platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : platform;
  return `Computer use drives macOS apps, and this environment runs on ${where}${platform === "linux" ? ", usually a headless server with no desktop to control" : ""}. Do not try to control apps here. For web pages, use the preview_* browser tools; they run a headless browser on this server.`;
}

/**
 * The name macOS lists the grants under. A server the desktop app started
 * inherits Cogenly's grants; one started from a terminal inherits the
 * terminal's, which is why the name is reported rather than assumed.
 */
export function hostAppName(input: {
  readonly platform: string;
  readonly executablePath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.platform !== "darwin") return null;
  const bundle = /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(input.executablePath)?.[1];
  if (bundle) return bundle;
  const terminals: Record<string, string> = {
    "com.apple.Terminal": "Terminal",
    "com.googlecode.iterm2": "iTerm",
    "com.mitchellh.ghostty": "Ghostty",
    "dev.warp.Warp-Stable": "Warp",
    "net.kovidgoyal.kitty": "kitty",
    "com.microsoft.VSCode": "Visual Studio Code",
  };
  const bundleId = input.environment.__CFBundleIdentifier;
  if (bundleId && terminals[bundleId]) return terminals[bundleId]!;
  const program = input.environment.TERM_PROGRAM;
  if (program === "Apple_Terminal") return "Terminal";
  if (program === "iTerm.app") return "iTerm";
  return null;
}

export function buildComputerUseStatus(input: {
  readonly platform: string;
  readonly enabled: boolean;
  readonly hostApp: string | null;
  /** Null when the probe failed to run; ignored off macOS. */
  readonly probe: ComputerUseProbe | null;
  /**
   * Report only the grants this tool needs, so a missing Screen Recording
   * does not hold up an agent that only wants to click.
   */
  readonly tool?: string | undefined;
}): ComputerUseStatus {
  const unsupported = unsupportedReason(input.platform);
  const app = input.hostApp ?? "the app that started the Cogenly server";
  const relevant =
    input.tool !== undefined && input.tool in COMPUTER_TOOL_PERMISSION
      ? COMPUTER_USE_PERMISSIONS.filter(
          (permission) => permission === COMPUTER_TOOL_PERMISSION[input.tool!],
        )
      : COMPUTER_USE_PERMISSIONS;
  const permissions =
    unsupported === undefined
      ? relevant.map((permission) => ({
          permission,
          grant: grantOf(input.probe, permission),
          title: COMPUTER_USE_PERMISSION_TITLES[permission],
          neededFor: NEEDED_FOR[permission],
          settingsUrl: COMPUTER_USE_PERMISSION_SETTINGS_URLS[permission],
        }))
      : [];
  const base = {
    enabled: input.enabled,
    supported: unsupported === undefined,
    platform: input.platform,
    hostApp: input.hostApp,
    permissions,
  };
  if (unsupported !== undefined) {
    return { ...base, state: "unsupported", reason: unsupported, nextSteps: [] };
  }
  if (!input.enabled) {
    return {
      ...base,
      state: "disabled",
      reason: "The owner turned computer use off for agents.",
      nextSteps: [
        "Ask the user to turn on Computer use in Settings → Integrations → Agent access if they want you to control apps. Do not work around it with osascript or other scripts.",
      ],
    };
  }
  if (input.probe !== null && input.probe.displays === 0) {
    return {
      ...base,
      state: "unsupported",
      reason:
        "This Mac has no logged-in desktop session to control (it may be locked at the login window, or the server runs outside the user's session).",
      nextSteps: ["Ask the user to log in to the Mac's desktop, then call computer_status again."],
    };
  }
  const missing = permissions.filter((entry) => entry.grant !== "granted");
  if (missing.length === 0) return { ...base, state: "ready", nextSteps: [] };
  const names = missing.map((entry) => entry.title).join(" and ");
  return {
    ...base,
    state: "needs-permission",
    reason:
      input.probe === null
        ? "Could not check this Mac's privacy permissions."
        : `macOS has not granted ${app} ${names} yet.`,
    nextSteps: [
      ...missing.map(
        (entry) =>
          `Needs the user, once: System Settings → Privacy & Security → ${entry.title}, turn on ${app} (for ${entry.neededFor}). The thread shows them a button that opens that pane.`,
      ),
      "Cogenly notices the grant on its own; no restart is needed. Call computer_status again after the user says it is on.",
    ],
  };
}
