import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

/**
 * Chromium extensions installed into a browser profile. Each environment keeps
 * its own list per profile and unpacks the files under its Cogenly home; the
 * desktop panel and the server browser both load them where they can.
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
  /** The toolbar popup, relative to the extension root, when it has one. */
  popupPage: Schema.optional(Schema.String),
  optionsPage: Schema.optional(Schema.String),
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
  Schema.Literals(["popup", "options"]),
  TrimmedNonEmptyString,
]);
export type BrowserExtensionPage = typeof BrowserExtensionPage.Type;

/** `chrome-extension://<id>/<path>` for a page inside an extension. */
export const browserExtensionPageUrl = (id: string, path: string) =>
  `chrome-extension://${id}/${path.replace(/^\/+/, "")}`;
