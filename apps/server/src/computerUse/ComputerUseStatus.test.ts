import { describe, expect, it } from "@effect/vitest";

import { buildComputerUseStatus, hostAppName } from "./ComputerUseStatus.ts";

const mac = (probe: Parameters<typeof buildComputerUseStatus>[0]["probe"], tool?: string) =>
  buildComputerUseStatus({ platform: "darwin", enabled: true, hostApp: "Cogenly", probe, tool });

const grants = (status: ReturnType<typeof mac>) =>
  Object.fromEntries(status.permissions.map((entry) => [entry.permission, entry.grant]));

describe("buildComputerUseStatus", () => {
  it("is ready once macOS reports both grants", () => {
    const status = mac({ accessibility: true, screenRecording: true, displays: 1 });
    expect(status.state).toBe("ready");
    expect(status.nextSteps).toEqual([]);
  });

  it("walks from nothing granted to ready as the user grants each permission, without a restart", () => {
    const states = [
      { accessibility: false, screenRecording: false, displays: 1 },
      { accessibility: true, screenRecording: false, displays: 1 },
      { accessibility: true, screenRecording: true, displays: 1 },
    ].map((probe) => {
      const status = mac(probe);
      return { state: status.state, grants: grants(status), reason: status.reason };
    });
    expect(states).toEqual([
      {
        state: "needs-permission",
        grants: { accessibility: "missing", "screen-recording": "missing" },
        reason: "macOS has not granted Cogenly Accessibility and Screen Recording yet.",
      },
      {
        state: "needs-permission",
        grants: { accessibility: "granted", "screen-recording": "missing" },
        reason: "macOS has not granted Cogenly Screen Recording yet.",
      },
      {
        state: "ready",
        grants: { accessibility: "granted", "screen-recording": "granted" },
        reason: undefined,
      },
    ]);
  });

  it("names the exact pane and app in each next step", () => {
    const status = mac({ accessibility: false, screenRecording: true, displays: 1 });
    expect(status.nextSteps[0]).toContain(
      "System Settings → Privacy & Security → Accessibility, turn on Cogenly",
    );
    expect(
      status.permissions.find((entry) => entry.permission === "accessibility")?.settingsUrl,
    ).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });

  it("never treats a probe that could not run as granted", () => {
    const status = mac(null);
    expect(status.state).toBe("needs-permission");
    expect(grants(status)).toEqual({ accessibility: "unknown", "screen-recording": "unknown" });
  });

  it("scopes the report to the grant a tool needs", () => {
    const probe = { accessibility: true, screenRecording: false, displays: 1 };
    expect(mac(probe, "computer_click").state).toBe("ready");
    const screenshot = mac(probe, "computer_screenshot");
    expect(screenshot.state).toBe("needs-permission");
    expect(screenshot.permissions.map((entry) => entry.permission)).toEqual(["screen-recording"]);
  });

  it("reports a Mac without a desktop session as unsupported", () => {
    expect(mac({ accessibility: true, screenRecording: true, displays: 0 }).state).toBe(
      "unsupported",
    );
  });

  it("says plainly that Linux servers cannot do computer use", () => {
    const status = buildComputerUseStatus({
      platform: "linux",
      enabled: true,
      hostApp: null,
      probe: null,
    });
    expect(status).toMatchObject({ state: "unsupported", supported: false, permissions: [] });
    expect(status.reason).toContain("preview_* browser tools");
  });

  it("reports the owner's off switch before any permission", () => {
    const status = buildComputerUseStatus({
      platform: "darwin",
      enabled: false,
      hostApp: "Cogenly",
      probe: { accessibility: false, screenRecording: false, displays: 1 },
    });
    expect(status.state).toBe("disabled");
  });
});

describe("hostAppName", () => {
  it("names the app bundle the server runs inside", () => {
    expect(
      hostAppName({
        platform: "darwin",
        executablePath: "/Applications/Cogenly.app/Contents/MacOS/Cogenly",
        environment: {},
      }),
    ).toBe("Cogenly");
  });

  it("names the terminal a dev server was started from", () => {
    expect(
      hostAppName({
        platform: "darwin",
        executablePath: "/opt/homebrew/bin/node",
        environment: { __CFBundleIdentifier: "com.googlecode.iterm2" },
      }),
    ).toBe("iTerm");
  });

  it("is null off macOS", () => {
    expect(
      hostAppName({ platform: "linux", executablePath: "/usr/bin/node", environment: {} }),
    ).toBe(null);
  });
});
