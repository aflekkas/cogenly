import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { foldLegacyDeviceOnboarding } from "./serverSettings.ts";

describe("device defaults", () => {
  it("are on for installs that never touched them", () => {
    expect(DEFAULT_SERVER_SETTINGS.enableDeviceSupport).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.enableAgentDeviceAccess).toBe(true);
  });
});

describe("foldLegacyDeviceOnboarding", () => {
  const finishedWizard = { ...DEFAULT_SERVER_SETTINGS, deviceOnboardingCompleted: true };

  it("leaves an install that never finished the wizard on the new defaults", () => {
    expect(foldLegacyDeviceOnboarding(DEFAULT_SERVER_SETTINGS, {})).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("keeps both switches off when the finished wizard left them out of the file", () => {
    const folded = foldLegacyDeviceOnboarding(finishedWizard, { deviceOnboardingCompleted: true });
    expect(folded.enableDeviceSupport).toBe(false);
    expect(folded.enableAgentDeviceAccess).toBe(false);
    expect(folded.deviceOnboardingCompleted).toBe(false);
  });

  it("keeps agent access off when only the hub was turned on", () => {
    const folded = foldLegacyDeviceOnboarding(finishedWizard, {
      deviceOnboardingCompleted: true,
      enableDeviceSupport: true,
    });
    expect(folded.enableDeviceSupport).toBe(true);
    expect(folded.enableAgentDeviceAccess).toBe(false);
  });

  it("keeps switches the file stores as on", () => {
    const folded = foldLegacyDeviceOnboarding(finishedWizard, {
      deviceOnboardingCompleted: true,
      enableDeviceSupport: true,
      enableAgentDeviceAccess: true,
    });
    expect(folded.enableDeviceSupport).toBe(true);
    expect(folded.enableAgentDeviceAccess).toBe(true);
  });

  it("runs once: with the flag cleared a later opt-in is not undone", () => {
    const once = foldLegacyDeviceOnboarding(finishedWizard, { deviceOnboardingCompleted: true });
    const turnedBackOn = { ...once, enableDeviceSupport: true };
    expect(foldLegacyDeviceOnboarding(turnedBackOn, {})).toBe(turnedBackOn);
  });
});
