import * as Schema from "effect/Schema";

/**
 * Site permissions in the desktop browser: what a page may use (camera,
 * microphone, location...) is decided per origin, per browser profile. The
 * desktop's browser session stores the decisions; the web client shows the
 * prompt and the site settings, and agents reach the same state through
 * `preview_permission`. Anything not listed here stays denied.
 */
export const SITE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "midi",
] as const;
export const SitePermission = Schema.Literals(SITE_PERMISSIONS);
export type SitePermission = typeof SitePermission.Type;

/** `ask` is "no decision": the page prompts the person the next time it needs the permission. */
export const SitePermissionSetting = Schema.Literals(["allow", "block", "ask"]);
export type SitePermissionSetting = typeof SitePermissionSetting.Type;

/** Who made a decision. An agent can never override a person's explicit Block. */
export const SitePermissionDecidedBy = Schema.Literals(["user", "agent"]);
export type SitePermissionDecidedBy = typeof SitePermissionDecidedBy.Type;

export const SitePermissionEntry = Schema.Struct({
  permission: SitePermission,
  setting: SitePermissionSetting,
  /** Absent when the setting is `ask`. */
  decidedBy: Schema.optional(SitePermissionDecidedBy),
});
export type SitePermissionEntry = typeof SitePermissionEntry.Type;

/** A page waiting on the person: "<origin> wants to use your camera". */
export const SitePermissionPrompt = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  permissions: Schema.Array(SitePermission),
});
export type SitePermissionPrompt = typeof SitePermissionPrompt.Type;

/** One tab's site permissions, for the origin it shows now. */
export const SitePermissionsState = Schema.Struct({
  /** Null while the tab shows no http(s) page, which has nothing to decide. */
  origin: Schema.NullOr(Schema.String),
  /** Every supported permission, in a fixed order. */
  entries: Schema.Array(SitePermissionEntry),
  /** The oldest request still waiting on the person, if any. */
  prompt: Schema.NullOr(SitePermissionPrompt),
});
export type SitePermissionsState = typeof SitePermissionsState.Type;

export const SitePermissionPromptAnswer = Schema.Literals(["allow", "block", "dismiss"]);
export type SitePermissionPromptAnswer = typeof SitePermissionPromptAnswer.Type;

/** Why a change was refused. */
export const SitePermissionRefusal = Schema.Literals(["user-blocked", "no-origin", "unknown-tab"]);
export type SitePermissionRefusal = typeof SitePermissionRefusal.Type;

/** What `preview_permission` and the desktop channel answer a change with. */
export const SitePermissionChangeResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), state: SitePermissionsState }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: SitePermissionRefusal,
    state: Schema.NullOr(SitePermissionsState),
  }),
]);
export type SitePermissionChangeResult = typeof SitePermissionChangeResult.Type;
