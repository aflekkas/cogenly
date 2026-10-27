import type {
  BrowserExtension,
  BrowserExtensionInstallResult,
  PreviewExtensionSurface,
  PreviewSessionSnapshot,
} from "@cogenly/contracts";

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

/** How many extension icons the browser toolbar shows before the rest move into its menu. */
export const BROWSER_EXTENSION_TOOLBAR_LIMIT = 3;

/**
 * The toolbar's icons: enabled extensions with a toolbar action, in install
 * order, the first few inline and the rest in the extensions menu. An
 * extension whose popup is open takes the last inline slot, so the popup has
 * an icon to hang from.
 */
export function browserExtensionToolbarLayout(
  extensions: ReadonlyArray<BrowserExtension>,
  options: { readonly promoteId?: string | null; readonly limit?: number } = {},
): {
  readonly inline: ReadonlyArray<BrowserExtension>;
  readonly overflow: ReadonlyArray<BrowserExtension>;
} {
  const limit = options.limit ?? BROWSER_EXTENSION_TOOLBAR_LIMIT;
  const shown = extensions.filter((extension) => extension.enabled && extension.hasAction);
  const inline = shown.slice(0, limit);
  const promoted = options.promoteId
    ? shown.slice(limit).find((extension) => extension.id === options.promoteId)
    : undefined;
  if (promoted && limit > 0) {
    inline.splice(limit - 1, 1, promoted);
  }
  const inlineIds = new Set(inline.map((extension) => extension.id));
  return { inline, overflow: shown.filter((extension) => !inlineIds.has(extension.id)) };
}

export interface BrowserExtensionStatus {
  readonly tone: "destructive" | "info" | "muted";
  readonly label: string;
  /** The browser's own words for what went wrong, when it said. */
  readonly detail: string | null;
}

/** What to say about an extension that is not simply running, or null when it is. */
export function browserExtensionStatus(
  extension: Pick<BrowserExtension, "enabled" | "state" | "error" | "loadError">,
): BrowserExtensionStatus | null {
  if (!extension.enabled || extension.state === "disabled") {
    return { tone: "muted", label: "Off", detail: null };
  }
  switch (extension.state) {
    case "loaded":
      return null;
    case "installing":
      return { tone: "info", label: "Loading", detail: null };
    case "pending":
      return { tone: "muted", label: "Loads when a tab opens", detail: null };
    case "failed":
      return {
        tone: "destructive",
        label: "Failed to load",
        detail: extension.error ?? extension.loadError ?? null,
      };
  }
}

/**
 * Why the extensions can't run in this tab, or null when they can. They run
 * only in the environment's built-in Chrome: a streamed server tab. A desktop
 * tab of a remote machine runs on this computer instead, and a tab the desktop
 * app already draws natively keeps its page rather than moving.
 */
export function browserExtensionTabGap(input: {
  readonly snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null;
  readonly rendersNatively: boolean;
  readonly remoteEnvironmentLabel: string | null;
  readonly incognito: boolean;
}): string | null {
  if (input.incognito) return "Incognito tabs run without extensions.";
  if (!input.snapshot) return "Open a page to use extensions.";
  if (input.snapshot.runtime === "server" && !input.rendersNatively) return null;
  if (input.snapshot.runtime !== "server" && input.remoteEnvironmentLabel !== null) {
    return `Extensions run in ${input.remoteEnvironmentLabel}'s browser.`;
  }
  return "Extensions run in Cogenly's built-in Chrome. Open a new tab to use them.";
}

/** Chrome's own bounds for an action popup. */
const POPUP_MIN = { width: 25, height: 25 } as const;
const POPUP_MAX = { width: 800, height: 600 } as const;
/** Until the page says how big it is. */
const POPUP_DEFAULT = { width: 360, height: 480 } as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

/**
 * A popup's size: the size the server measured its page wanting, clamped to
 * Chrome's popup bounds. The panel caps it again to the space on screen, and
 * the stream follows the box it is drawn in, so the box never sets its own size.
 */
export function browserExtensionPopupSize(surface: PreviewExtensionSurface | undefined): {
  readonly width: number;
  readonly height: number;
} {
  const size = surface?.preferredSize ?? POPUP_DEFAULT;
  return {
    width: clamp(size.width, POPUP_MIN.width, POPUP_MAX.width),
    height: clamp(size.height, POPUP_MIN.height, POPUP_MAX.height),
  };
}

/** A popup the user asked for from the toolbar; its tab is null until the server names it. */
export interface BrowserExtensionPopupRequest {
  readonly hostTabId: string;
  readonly extensionId: string;
  readonly surfaceTabId: string | null;
}

/**
 * Whether the user opened this popup. Only theirs take focus and close on a
 * click outside or Esc; one an agent opened stays until the agent closes it
 * or the user presses its close button, and never pulls focus from the chat.
 */
export function isUserOpenedBrowserExtensionPopup(
  popup: Pick<PreviewSessionSnapshot, "tabId" | "extensionSurface">,
  request: BrowserExtensionPopupRequest | null,
): boolean {
  const surface = popup.extensionSurface;
  if (!request || surface?.kind !== "popup") return false;
  if (request.surfaceTabId !== null) return request.surfaceTabId === popup.tabId;
  return surface.hostTabId === request.hostTabId && surface.extensionId === request.extensionId;
}

/**
 * What clicking an extension's toolbar icon does. One that failed to load
 * shows its details, which explain why, even in a tab that can't run it.
 */
export function browserExtensionIconAction(
  extension: Pick<BrowserExtension, "name" | "state">,
  context: { readonly gap: string | null; readonly popupOpen: boolean },
): { readonly action: "details" | "close" | "open"; readonly unavailableReason: string | null } {
  if (extension.state === "failed") return { action: "details", unavailableReason: null };
  if (context.popupOpen) return { action: "close", unavailableReason: null };
  return {
    action: "open",
    unavailableReason:
      context.gap ?? (extension.state === "installing" ? `${extension.name} is loading` : null),
  };
}

/**
 * Whether an extension can open its pages from a tab: it is on and loaded, or
 * waiting for a tab to start it, which opening its page in one does.
 */
export const isBrowserExtensionUsable = (extension: Pick<BrowserExtension, "enabled" | "state">) =>
  extension.enabled && (extension.state === "loaded" || extension.state === "pending");

/** Whether an extension can open its side panel now. */
export const canOpenBrowserExtensionSidePanel = (
  extension: Pick<BrowserExtension, "enabled" | "state" | "sidePanelPage">,
) => isBrowserExtensionUsable(extension) && extension.sidePanelPage !== undefined;

/**
 * The side panel the keybinding toggles: the extension whose side panel opened
 * last, or else the first that has one.
 */
export function browserExtensionSidePanelTarget(
  extensions: ReadonlyArray<BrowserExtension>,
  recentId: string | null,
): BrowserExtension | null {
  const eligible = extensions.filter(canOpenBrowserExtensionSidePanel);
  return eligible.find((extension) => extension.id === recentId) ?? eligible[0] ?? null;
}
