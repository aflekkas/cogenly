import { describe, expect, it } from "vite-plus/test";

import { resourceMonitorUnavailableText } from "./ResourceTelemetryDiagnostics.logic";

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
