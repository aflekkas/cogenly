import { describe, expect, it } from "vite-plus/test";
import {
  desktopUpdateDownloadUrl,
  isStagingDesktopVersion,
  requiresManualMacUpdate,
  resolveDefaultDesktopUpdateChannel,
  resolveDesktopUpdateFeed,
} from "./updateChannels.ts";

describe("desktop update channels", () => {
  it("keeps prod on latest-mac.yml without prereleases", () => {
    expect(resolveDefaultDesktopUpdateChannel("1.2.3")).toBe("latest");
    expect(resolveDesktopUpdateFeed("latest")).toEqual({
      channel: "latest",
      allowPrerelease: false,
      manifest: "latest-mac.yml",
    });
  });
  it("defaults staging builds to staging-mac.yml and allows prereleases", () => {
    expect(resolveDefaultDesktopUpdateChannel("1.2.3-staging.20261019.42")).toBe("staging");
    expect(resolveDesktopUpdateFeed("staging")).toEqual({
      channel: "staging",
      allowPrerelease: true,
      manifest: "staging-mac.yml",
    });
    expect(isStagingDesktopVersion("1.2.3-foo-staging.20261019.42")).toBe(false);
    expect(isStagingDesktopVersion("1.2.3-staging.42")).toBe(false);
  });
  it("uses the DMG download for unsigned macOS apps and keeps signed installs automatic", () => {
    expect(requiresManualMacUpdate("darwin", false)).toBe(true);
    expect(requiresManualMacUpdate("darwin", true)).toBe(false);
    expect(requiresManualMacUpdate("linux", false)).toBe(false);
    expect(desktopUpdateDownloadUrl("1.2.3", "http://localhost:3000/")).toBe(
      "http://localhost:3000/Cogenly-1.2.3-arm64.dmg",
    );
    expect(desktopUpdateDownloadUrl("1.2.3-staging.20261019.42")).toBe(
      "https://github.com/aflekkas/cogenly/releases/download/v1.2.3-staging.20261019.42/Cogenly-1.2.3-staging.20261019.42-arm64.dmg",
    );
  });
});
