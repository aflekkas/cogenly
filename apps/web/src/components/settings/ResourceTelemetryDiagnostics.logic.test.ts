import { describe, expect, it } from "vite-plus/test";

import {
  resourceMonitorRecovery,
  resourceMonitorUnavailableText,
} from "./ResourceTelemetryDiagnostics.logic";

describe("resourceMonitorRecovery", () => {
  it("only restarts the monitor while the server's sampling shows its own refresh", () => {
    expect(resourceMonitorRecovery({ canRestartMonitor: true, samplersHidden: false })).toEqual({
      restartsMonitor: true,
      refreshesSamplers: false,
    });
  });

  it("also refreshes both samplers once their sections are folded into the row", () => {
    expect(resourceMonitorRecovery({ canRestartMonitor: true, samplersHidden: true })).toEqual({
      restartsMonitor: true,
      refreshesSamplers: true,
    });
  });

  it("still lets a viewer who can't restart the monitor re-sample hidden samplers", () => {
    expect(resourceMonitorRecovery({ canRestartMonitor: false, samplersHidden: true })).toEqual({
      restartsMonitor: false,
      refreshesSamplers: true,
    });
  });

  it("offers nothing when neither applies", () => {
    expect(resourceMonitorRecovery({ canRestartMonitor: false, samplersHidden: false })).toBeNull();
  });
});

describe("resourceMonitorUnavailableText", () => {
  it("keeps the monitor's reason alone while process sampling works", () => {
    expect(resourceMonitorUnavailableText("The monitor stopped.", null)).toBe(
      "The monitor stopped.",
    );
  });

  it("says a shared reason once when process sampling failed the same way", () => {
    const reason = "Resource monitor binary was not found for darwin/arm64";
    expect(resourceMonitorUnavailableText(reason, [reason, reason])).toBe(
      "Resource monitor binary was not found for darwin/arm64. Live processes and resource history show here once it runs.",
    );
  });

  it("adds a different sampling reason after the monitor's", () => {
    expect(resourceMonitorUnavailableText("The monitor stopped.", ["ps failed"])).toBe(
      "The monitor stopped. ps failed. Live processes and resource history show here once it runs.",
    );
  });
});
