import * as Schema from "effect/Schema";
import { BrowserImportSourceId } from "./browserImport.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CookieDomain = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
  ),
);

export const BrowserCookieImportInput = Schema.Struct({
  sourceId: Schema.optional(BrowserImportSourceId),
  sourceProfileDirectory: Schema.optional(TrimmedNonEmptyString),
  targetProfileId: Schema.optional(BrowserProfileId),
  /** Omit only for an explicitly requested import of everything. */
  domains: Schema.optional(Schema.Array(CookieDomain).check(Schema.isMinLength(1))),
  dryRun: Schema.optional(Schema.Boolean),
});
export type BrowserCookieImportInput = typeof BrowserCookieImportInput.Type;

/** Bootstrap file descriptors only. Never use this schema in RPC, MCP, sync or vault payloads. */
export const LocalImportedBrowserCookie = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  value: Schema.String,
  domain: Schema.optional(Schema.String),
  path: Schema.String,
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  expirationDate: Schema.optional(Schema.Number),
  sameSite: Schema.Literals(["unspecified", "no_restriction", "lax", "strict"]),
});

/** Counts only. Cookie names and values never cross a transport. */
export const BrowserCookieImportResult = Schema.Struct({
  targetProfileId: BrowserProfileId,
  dryRun: Schema.Boolean,
  imported: Schema.Int,
  available: Schema.Int,
  skipped: Schema.Int,
  domains: Schema.Array(Schema.Struct({ domain: Schema.String, count: Schema.Int })),
  warnings: Schema.Array(Schema.String),
  reloadRequired: Schema.Boolean,
});
export type BrowserCookieImportResult = typeof BrowserCookieImportResult.Type;

export class BrowserCookieImportError extends Schema.TaggedError<BrowserCookieImportError>()(
  "BrowserCookieImportError",
  { message: Schema.String },
) {}
