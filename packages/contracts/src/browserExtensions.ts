import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import { PreviewTabId } from "./preview.ts";

/**
 * Chromium extensions installed into a browser profile. Each environment keeps
 * its own list per profile and unpacks the files under its Cogenly home; the
 * server runs them in full Chrome, streamed to web and desktop clients.
 */

/** Chrome's extension ID: 32 letters a to p. */
export const BrowserExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
export type BrowserExtensionId = typeof BrowserExtensionId.Type;

export const BrowserExtensionSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("webStore") }),
  /** An unpacked folder on the environment's machine, copied in at install. */
  Schema.Struct({ type: Schema.Literal("folder"), path: TrimmedNonEmptyString }),
]);
export type BrowserExtensionSource = typeof BrowserExtensionSource.Type;

/**
 * Pending waits for a profile tab to open; installing is an active load attempt.
 * Loaded and failed record that attempt's result; disabled is explicitly turned off.
 */
export const BrowserExtensionLoadState = Schema.Literals([
  "loaded",
  "failed",
  "installing",
  "pending",
  "disabled",
]);
export type BrowserExtensionLoadState = typeof BrowserExtensionLoadState.Type;

export const BrowserExtension = Schema.Struct({
  id: BrowserExtensionId,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  manifestVersion: Schema.Int,
  enabled: Schema.Boolean,
  source: BrowserExtensionSource,
  /** API permissions the manifest asks for, such as `storage` or `tabs`. */
  permissions: Schema.Array(Schema.String),
  /** Sites it can read and change: host permissions and content script matches. */
  hostPermissions: Schema.Array(Schema.String),
  /** Toolbar or manifest icon as a data URL, capped at 16KB including its prefix. */
  icon: Schema.optional(Schema.String.check(Schema.isMaxLength(16_384))),
  hasAction: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidePanelPage: Schema.optional(Schema.String),
  /** The toolbar popup, relative to the extension root, when it has one. */
  popupPage: Schema.optional(Schema.String),
  optionsPage: Schema.optional(Schema.String),
  state: BrowserExtensionLoadState.pipe(Schema.withDecodingDefault(Effect.succeed("pending"))),
  error: Schema.optional(Schema.String),
  /** Why this enabled extension could not load in the server browser. */
  loadError: Schema.optional(Schema.String),
  installedAt: Schema.String,
});
export type BrowserExtension = typeof BrowserExtension.Type;

export const BrowserExtensionsListInput = Schema.Struct({
  /** Defaults to the default profile. */
  profileId: Schema.optional(BrowserProfileId),
});
export type BrowserExtensionsListInput = typeof BrowserExtensionsListInput.Type;

export const BrowserExtensionsListResult = Schema.Struct({
  profileId: BrowserProfileId,
  extensions: Schema.Array(BrowserExtension),
});
export type BrowserExtensionsListResult = typeof BrowserExtensionsListResult.Type;

export const BrowserExtensionInstallInput = Schema.Struct({
  profileId: Schema.optional(BrowserProfileId),
  /**
   * A Chrome Web Store link, a bare extension ID, or an absolute path to an
   * unpacked extension folder on the environment's machine.
   */
  source: TrimmedNonEmptyString,
});
export type BrowserExtensionInstallInput = typeof BrowserExtensionInstallInput.Type;

export const BrowserExtensionInstallResult = Schema.Struct({
  profileId: BrowserProfileId,
  extension: BrowserExtension,
  /** True when this replaced an installed copy, as an update does. */
  updated: Schema.Boolean,
  previousVersion: Schema.optional(Schema.String),
});
export type BrowserExtensionInstallResult = typeof BrowserExtensionInstallResult.Type;

export const BrowserExtensionRemoveInput = Schema.Struct({
  profileId: Schema.optional(BrowserProfileId),
  id: BrowserExtensionId,
});
export type BrowserExtensionRemoveInput = typeof BrowserExtensionRemoveInput.Type;

export const BrowserExtensionToggleInput = Schema.Struct({
  profileId: Schema.optional(BrowserProfileId),
  id: BrowserExtensionId,
  enabled: Schema.Boolean,
});
export type BrowserExtensionToggleInput = typeof BrowserExtensionToggleInput.Type;

export class BrowserExtensionError extends Schema.TaggedError<BrowserExtensionError>()(
  "BrowserExtensionError",
  { message: Schema.String },
) {}

/** The page of an installed extension a tab opens: its popup, options, or any path inside it. */
export const BrowserExtensionPage = Schema.Union([
  Schema.Literals(["popup", "options", "sidePanel", "action"]),
  TrimmedNonEmptyString,
]);
export type BrowserExtensionPage = typeof BrowserExtensionPage.Type;

/** `chrome-extension://<id>/<path>` for a page inside an extension. */
export const browserExtensionPageUrl = (id: string, path: string) =>
  `chrome-extension://${id}/${path.replace(/^\/+/, "")}`;

/** Reload an unpacked extension from its original folder on this environment. */
export const BrowserExtensionReloadInput = Schema.Struct({
  profileId: Schema.optional(BrowserProfileId),
  id: BrowserExtensionId,
});
export type BrowserExtensionReloadInput = typeof BrowserExtensionReloadInput.Type;

export const BrowserExtensionOpenSurfaceInput = Schema.Struct({
  profileId: Schema.optional(BrowserProfileId),
  id: BrowserExtensionId,
  kind: Schema.Literals(["popup", "sidePanel", "action"]),
  hostTabId: PreviewTabId,
  threadId: Schema.optional(ThreadId),
});
export type BrowserExtensionOpenSurfaceInput = typeof BrowserExtensionOpenSurfaceInput.Type;

export const BrowserExtensionOpenSurfaceResult = Schema.Struct({
  surfaceTabId: Schema.optional(PreviewTabId),
});
export type BrowserExtensionOpenSurfaceResult = typeof BrowserExtensionOpenSurfaceResult.Type;

export class BrowserExtensionSurfaceNotImplementedError extends Schema.TaggedError<BrowserExtensionSurfaceNotImplementedError>()(
  "BrowserExtensionSurfaceNotImplementedError",
  {},
) {
  override get message(): string {
    return "Extension surfaces are not available yet. Open the extension's options page or a page path instead.";
  }
}
