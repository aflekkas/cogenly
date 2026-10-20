import type { DesktopUpdateChannel } from "@t3tools/contracts";

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

export function requiresManualMacUpdate(platform: NodeJS.Platform, signed: boolean): boolean {
  return platform === "darwin" && !signed;
}

export function desktopUpdateDownloadUrl(version: string, genericFeedUrl?: string): string {
  const baseUrl =
    genericFeedUrl?.replace(/\/+$/, "") ??
    `https://github.com/aflekkas/cogenly/releases/download/v${encodeURIComponent(version)}`;
  return `${baseUrl}/Cogenly-${encodeURIComponent(version)}-arm64.dmg`;
}
