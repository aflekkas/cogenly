import { expect, it } from "vite-plus/test";
import { nextRemoteDesktopUpdateStep } from "./remoteUpdateFlow.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

it("ends remote updates with actionable guidance when unsigned macOS needs a DMG", () => {
  const state = {
    ...createInitialDesktopUpdateState(
      "1.2.2",
      { appArch: "arm64", hostArch: "arm64", runningUnderArm64Translation: false },
      "latest",
    ),
    enabled: true,
    status: "available" as const,
    availableVersion: "1.2.3",
    manualDownloadUrl:
      "https://github.com/aflekkas/cogenly/releases/download/v1.2.3/Cogenly-1.2.3-arm64.dmg",
  };
  expect(nextRemoteDesktopUpdateStep(state, { checks: 1, downloads: 0 }, null)).toEqual({
    action: "done",
    outcome: "failed",
    reason:
      "This macOS app is unsigned. Download and install the update from Settings on that Mac.",
  });
});
