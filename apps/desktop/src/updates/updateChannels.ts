import type { DesktopUpdateChannel } from "@cogenly/contracts";

const STAGING_VERSION_PATTERN = /^[^-+]+-staging\.\d{8}\.\d+$/;

export function isStagingDesktopVersion(version: string): boolean {
  return STAGING_VERSION_PATTERN.test(version);
}

// `latest` is the persisted prod ID and electron-updater's manifest name.
export function resolveDefaultDesktopUpdateChannel(version: string): DesktopUpdateChannel {
  return isStagingDesktopVersion(version) ? "staging" : "latest";
}

export function resolveDesktopUpdateFeed(channel: DesktopUpdateChannel) {
  return {
    channel,
    allowPrerelease: channel === "staging",
    manifest: `${channel}-mac.yml`,
  };
}

/** Unsigned macOS apps cannot use Squirrel.Mac, so they install updates themselves. */
export function usesUnsignedMacInstall(platform: NodeJS.Platform, signed: boolean): boolean {
  return platform === "darwin" && !signed;
}

/** URL of one release asset, from the GitHub release or a generic (mock) feed. */
export function desktopUpdateAssetUrl(
  version: string,
  fileName: string,
  genericFeedUrl?: string,
): string {
  const baseUrl =
    genericFeedUrl?.replace(/\/+$/, "") ??
    `https://github.com/aflekkas/cogenly/releases/download/v${encodeURIComponent(version)}`;
  return `${baseUrl}/${encodeURIComponent(fileName)}`;
}

export function desktopUpdateDownloadUrl(version: string, genericFeedUrl?: string): string {
  return desktopUpdateAssetUrl(version, `Cogenly-${version}-arm64.dmg`, genericFeedUrl);
}
