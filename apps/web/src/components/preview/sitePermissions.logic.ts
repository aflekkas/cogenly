import type {
  SitePermission,
  SitePermissionEntry,
  SitePermissionPrompt,
  SitePermissionSetting,
} from "@t3tools/contracts";

/** The name a permission goes by in the site settings menu. */
export const SITE_PERMISSION_LABELS: Readonly<Record<SitePermission, string>> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Clipboard",
  midi: "MIDI devices",
};

export const SITE_PERMISSION_SETTING_LABELS: Readonly<Record<SitePermissionSetting, string>> = {
  allow: "Allow",
  ask: "Ask",
  block: "Block",
};

/** What a page asks to do, as "<verb> <noun>"; permissions sharing a verb read as one phrase. */
const REQUEST_PHRASES: Readonly<Record<SitePermission, { verb: string; noun: string }>> = {
  camera: { verb: "use your", noun: "camera" },
  microphone: { verb: "use your", noun: "microphone" },
  geolocation: { verb: "know", noun: "your location" },
  notifications: { verb: "show", noun: "notifications" },
  "clipboard-read": { verb: "see", noun: "what you copied" },
  midi: { verb: "use your", noun: "MIDI devices" },
};

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "camera and microphone" style phrase for what the page wants, e.g. "use your camera and microphone". */
export function describeRequestedPermissions(permissions: ReadonlyArray<SitePermission>): string {
  const nounsByVerb = new Map<string, string[]>();
  for (const permission of permissions) {
    const { verb, noun } = REQUEST_PHRASES[permission];
    nounsByVerb.set(verb, [...(nounsByVerb.get(verb) ?? []), noun]);
  }
  return joinWithAnd([...nounsByVerb].map(([verb, nouns]) => `${verb} ${joinWithAnd(nouns)}`));
}

/** The prompt's headline: "app.example.com wants to use your camera". */
export function sitePermissionPromptTitle(prompt: SitePermissionPrompt): string {
  const host = URL.canParse(prompt.origin) ? new URL(prompt.origin).host : prompt.origin;
  return `${host} wants to ${describeRequestedPermissions(prompt.permissions)}`;
}

/** The host to show in the site settings menu, or null when the tab shows no web page. */
export function siteHost(origin: string | null): string | null {
  if (origin === null || !URL.canParse(origin)) return null;
  return new URL(origin).host;
}

/** How a menu row shows a permission's setting; a decision an agent made says so. */
export function siteSettingSummary(entry: SitePermissionEntry): string {
  const label = SITE_PERMISSION_SETTING_LABELS[entry.setting];
  return entry.decidedBy === "agent" ? `${label} · set by agent` : label;
}
