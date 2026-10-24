/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

/**
 * Every prod release attaches the Linux CLI archives and one SHA256SUMS next
 * to the macOS desktop build. `COGENLY_RELEASE_BASE_URL` still overrides the
 * origin for mirrors.
 */
const CLI_RELEASE_REPOSITORY: string | null = "aflekkas/cogenly";
/** Whether a default release origin exists to check for updates against. */
export const CLI_RELEASES_PUBLISHED: boolean = CLI_RELEASE_REPOSITORY !== null;
export const CLI_RELEASES_UNAVAILABLE_MESSAGE =
  "No Cogenly release origin is configured. Update the desktop app through Settings or install from source.";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "COGENLY_RELEASE_BASE_URL";

/**
 * The archives a release attaches. Kept in step with the `cli` matrix in
 * .github/workflows/release.yml: a key here without a build there produces
 * download URLs that 404, and a build there without a key here is
 * unreachable from every installer. macOS runs the server inside the desktop
 * app, so it has no CLI archive.
 */
export const CLI_ARCHIVE_PLATFORM_KEYS = ["linux-arm64", "linux-x64"] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * The tar to extract a release archive with. Windows ships bsdtar in
 * System32, which reads both formats; a Git-for-Windows GNU tar earlier on
 * PATH cannot open the zip, so the system copy is named by absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.tar.gz`;
}

const CLI_RELEASE_DEFAULT_BASE_URL =
  CLI_RELEASE_REPOSITORY === null
    ? null
    : `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

/**
 * Directory that `releases/download/<tag>/<asset>` lives under, or null when
 * neither a mirror nor a default release origin is configured.
 */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = undefined,
): string | null {
  const origin = baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL;
  return origin ? `${origin.replace(/\/+$/, "")}/v${version}` : null;
}

/**
 * Parses the `sha256sum` style checksum file attached to each release.
 * Lines are `<hex>  <file>`; a leading `*` marks binary mode and is ignored.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "prod" | "staging";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = ["prod", "staging"];

/** The release train a version was published on, derived from its prerelease tag. */
export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  return /^[^-+]+-staging\.\d{8}\.\d+$/.test(version) ? "staging" : "prod";
}

/**
 * One page of GitHub's list-releases endpoint, newest first. Callers walk pages
 * until a channel match turns up; a busy staging train can push the newest
 * prod release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string | null {
  return CLI_RELEASE_REPOSITORY === null
    ? null
    : `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/** GitHub's release for one exact version, or null without a release origin. */
export function cliReleaseTagApiUrl(version: string): string | null {
  return CLI_RELEASE_REPOSITORY === null
    ? null
    : `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(version)}`;
}

/**
 * Picks the newest version on a channel from the release index. Tags are
 * `v<version>`; the channel is decided by the same rule the runtime uses, so
 * staging tags never satisfy a prod lookup. Drafts are
 * skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (
      version === undefined ||
      (!/^\d+\.\d+\.\d+$/.test(version) && !/^[^-+]+-staging\.\d{8}\.\d+$/.test(version))
    )
      continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
