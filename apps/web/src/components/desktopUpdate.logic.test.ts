import { expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@cogenly/contracts";
import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic.ts";

it("offers download guidance when an unsigned Mac cannot update in place", () => {
  const state: DesktopUpdateState = {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "1.2.2",
    appArch: "arm64",
    hostArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "1.2.3",
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message:
      "Update available — download. Cogenly is running from its disk image. Drag it to Applications and open it from there to update in place.",
    errorContext: null,
    canRetry: false,
    manualDownloadUrl:
      "https://github.com/aflekkas/cogenly/releases/download/v1.2.3/Cogenly-1.2.3-arm64.dmg",
  };
  expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  expect(getDesktopUpdateButtonTooltip(state)).toContain("Drag it to Applications");
  expect(getDesktopUpdateButtonTooltip({ ...state, message: null })).toContain(
    "Install the DMG manually",
  );
  expect(getDesktopUpdateReleaseUrl("1.2.3")).toBe(
    "https://github.com/aflekkas/cogenly/releases/tag/v1.2.3",
  );
});
