/**
 * What `preview_permission` needs beyond the desktop: the headless browser has
 * no person to ask, so its pages get exactly what an agent grants through
 * Playwright, and the words agents read when a page waits on the user.
 */
import {
  SITE_PERMISSIONS,
  type SitePermission,
  type SitePermissionSetting,
  type SitePermissionsState,
} from "@cogenly/contracts";

/** Playwright's names for the permissions a context can grant. */
const PLAYWRIGHT_PERMISSION: Readonly<Record<SitePermission, string>> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  notifications: "notifications",
  "clipboard-read": "clipboard-read",
  midi: "midi",
};

/** The origin permissions are keyed by; null for anything but a web page. */
export function siteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Per-origin permission decisions for one headless browser context. Playwright
 * can grant but not block, so a Block simply stays ungranted: the page is
 * denied, which is what a person's Block does too.
 */
export class HeadlessSitePermissions {
  private readonly settings = new Map<string, Map<SitePermission, "allow" | "block">>();

  set(origin: string, permission: SitePermission, setting: SitePermissionSetting): void {
    const forOrigin = this.settings.get(origin) ?? new Map<SitePermission, "allow" | "block">();
    if (setting === "ask") forOrigin.delete(permission);
    else forOrigin.set(permission, setting);
    if (forOrigin.size === 0) this.settings.delete(origin);
    else this.settings.set(origin, forOrigin);
  }

  state(origin: string | null): SitePermissionsState {
    const forOrigin = origin === null ? undefined : this.settings.get(origin);
    return {
      origin,
      entries: SITE_PERMISSIONS.map((permission) => {
        const setting = forOrigin?.get(permission);
        return setting === undefined
          ? { permission, setting: "ask" as const }
          : { permission, setting, decidedBy: "agent" as const };
      }),
      prompt: null,
    };
  }

  /** What the context must have granted, per origin, in Playwright's terms. */
  grants(): ReadonlyArray<{
    readonly origin: string;
    readonly permissions: ReadonlyArray<string>;
  }> {
    return [...this.settings].flatMap(([origin, forOrigin]) => {
      const permissions = [...forOrigin]
        .filter(([, setting]) => setting === "allow")
        .map(([permission]) => PLAYWRIGHT_PERMISSION[permission]);
      return permissions.length === 0 ? [] : [{ origin, permissions }];
    });
  }
}

const PERMISSION_NOUN: Readonly<Record<SitePermission, string>> = {
  camera: "the camera",
  microphone: "the microphone",
  geolocation: "their location",
  notifications: "notifications",
  "clipboard-read": "the clipboard",
  midi: "MIDI devices",
};

/** What an agent should know when a page waits on the user, or undefined when none does. */
export function permissionPromptNotice(state: SitePermissionsState): string | undefined {
  const prompt = state.prompt;
  if (prompt === null || prompt.permissions.length === 0) return undefined;
  const wanted = prompt.permissions.map((permission) => PERMISSION_NOUN[permission]).join(" and ");
  return `${prompt.origin} is waiting for the user to allow ${wanted}; a prompt is open in the browser toolbar. Call preview_permission with decision "allow" for each permission to grant it, or ask the user to click Allow.`;
}

/** Why a change was refused, in words that name the next step. */
export function permissionRefusalMessage(
  reason: "user-blocked" | "no-origin" | "unknown-tab",
  permission: SitePermission,
  origin: string | null,
): string {
  switch (reason) {
    case "user-blocked":
      return `The user blocked ${PERMISSION_NOUN[permission]} for ${origin ?? "this site"}, so it cannot be changed here. Ask them to allow it from the browser menu's Site permissions.`;
    case "no-origin":
      return "This tab shows no web page yet. Navigate it first, or pass origin.";
    case "unknown-tab":
      return "The desktop app no longer shows this tab. Call preview_status and use a current tab.";
  }
}
