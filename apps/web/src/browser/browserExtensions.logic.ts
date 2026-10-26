import type { BrowserExtension, BrowserExtensionInstallResult } from "@cogenly/contracts";

/** How many sites or APIs a summary names before it counts the rest. */
const SUMMARY_NAMED_LIMIT = 3;

/** A match pattern's host, `*` for every host, or null when it names no site. */
function matchPatternHost(pattern: string): string | null {
  if (pattern === "<all_urls>") return "*";
  const match = /^(\*|https?|wss?|ftp|file):\/\/([^/]*)/.exec(pattern);
  if (!match) return null;
  if (match[1] === "file") return "local files";
  const host = match[2] ?? "";
  if (host === "" || host === "*") return "*";
  return host.replace(/^\*\./, "");
}

const looksLikeSitePattern = (permission: string) =>
  permission === "<all_urls>" || permission.includes("://");

function namedList(names: ReadonlyArray<string>): string {
  if (names.length <= SUMMARY_NAMED_LIMIT) return names.join(", ");
  const rest = names.length - SUMMARY_NAMED_LIMIT;
  return `${names.slice(0, SUMMARY_NAMED_LIMIT).join(", ")} and ${rest} more`;
}

export interface BrowserExtensionPermissionSummary {
  /** "Reads and changes: …" for the sites it can touch, or null when it touches none. */
  readonly sites: string | null;
  /** "Uses: …" for the browser APIs it asks for, or null when it asks for none. */
  readonly apis: string | null;
}

/**
 * What an extension may do, in a line or two. Manifest V2 lists sites among its
 * API permissions, so those count as sites wherever they appear.
 */
export function browserExtensionPermissionSummary(
  extension: Pick<BrowserExtension, "permissions" | "hostPermissions">,
): BrowserExtensionPermissionSummary {
  const patterns = [
    ...extension.hostPermissions,
    ...extension.permissions.filter(looksLikeSitePattern),
  ];
  const hosts = [...new Set(patterns.map(matchPatternHost).filter((host) => host !== null))];
  const apis = [
    ...new Set(extension.permissions.filter((permission) => !looksLikeSitePattern(permission))),
  ];
  return {
    sites:
      hosts.length === 0
        ? null
        : `Reads and changes: ${hosts.includes("*") ? "all sites" : namedList(hosts)}`,
    apis: apis.length === 0 ? null : `Uses: ${namedList(apis)}`,
  };
}

/** The summary as display lines, never empty. */
export function browserExtensionPermissionLines(
  extension: Pick<BrowserExtension, "permissions" | "hostPermissions">,
): ReadonlyArray<string> {
  const { sites, apis } = browserExtensionPermissionSummary(extension);
  const lines = [sites, apis].filter((line) => line !== null);
  return lines.length === 0 ? ["No special permissions"] : lines;
}

/** What to install to bring a removed extension back. */
export function browserExtensionReinstallSource(
  extension: Pick<BrowserExtension, "id" | "source">,
): string {
  return extension.source.type === "folder" ? extension.source.path : extension.id;
}

/** True when an install source is a folder path rather than a store link or ID. */
export function isFolderInstallSource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~") || /^[a-z]:[\\/]/i.test(trimmed);
}

export function browserExtensionInstalledMessage(result: BrowserExtensionInstallResult): string {
  const { name, version } = result.extension;
  if (!result.updated) return `Installed ${name} ${version}`;
  return result.previousVersion && result.previousVersion !== version
    ? `Updated ${name} from ${result.previousVersion} to ${version}`
    : `Reinstalled ${name} ${version}`;
}

/** The server's own words for a failure, or the fallback when it sent none. */
export function browserExtensionErrorMessage(cause: unknown, fallback: string): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = String(cause.message).trim();
    if (message !== "") return message;
  }
  return fallback;
}
