import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import { LocalImportedBrowserCookie } from "./browserCookies.ts";
import {
  SitePermission,
  SitePermissionChangeResult,
  SitePermissionSetting,
} from "./sitePermissions.ts";

/**
 * The desktop app renders browser tabs for the server it launched, and the
 * server drives them with the same engine as its headless tabs. Messages
 * travel as newline-delimited JSON over two bootstrap file descriptors, so
 * only that one server can reach the desktop's pages; nothing listens on a port.
 *
 * Each tab carries one CDP connection, multiplexed by `tabId`. CDP frames pass
 * through untouched; the desktop answers them with `CdpRelay`.
 */

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Desktop -> server. */
export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browserStorageResult"),
    requestId: Schema.String,
    success: Schema.Boolean,
  }),
  /** A desktop `<webview>` for this server tab is attached and can be driven. */
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  /** One CDP message from the tab's relay. */
  Schema.Struct({
    type: Schema.Literal("cdp"),
    ...TabKey,
    connectionId: TrimmedNonEmptyString,
    message: Schema.String,
  }),
  /** The answer to a `permission` command, matched by `requestId`. */
  Schema.Struct({
    type: Schema.Literal("permission"),
    ...TabKey,
    requestId: Schema.String,
    result: SitePermissionChangeResult,
  }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/** An element's box in viewport CSS pixels. */
export const DesktopBrowserPointerBox = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type DesktopBrowserPointerBox = typeof DesktopBrowserPointerBox.Type;

/** Server -> desktop. */
export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("clearProfile"),
    requestId: Schema.String,
    environmentId: TrimmedNonEmptyString,
    profileId: BrowserProfileId,
  }),
  /** Only the server this desktop spawned can send these over its inherited local pipe. */
  Schema.Struct({
    type: Schema.Literal("importCookie"),
    requestId: Schema.String,
    environmentId: TrimmedNonEmptyString,
    profileId: BrowserProfileId,
    cookie: LocalImportedBrowserCookie,
  }),
  /** Starts a generation before its first CDP command, retiring the old relay. */
  Schema.Struct({
    type: Schema.Literal("connect"),
    ...TabKey,
    connectionId: TrimmedNonEmptyString,
  }),
  /** One CDP message for the tab's relay. */
  Schema.Struct({
    type: Schema.Literal("cdp"),
    ...TabKey,
    connectionId: TrimmedNonEmptyString,
    message: Schema.String,
  }),
  /** The server stopped driving this tab, so the relay can drop its sessions. */
  Schema.Struct({
    type: Schema.Literal("release"),
    ...TabKey,
    connectionId: TrimmedNonEmptyString,
  }),
  /** Where an agent action is about to land, so the desktop draws its cursor there. */
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
    /** The element it acts on, in viewport CSS pixels, so the desktop can outline it. */
    box: Schema.optionalKey(DesktopBrowserPointerBox),
  }),
  /**
   * Reads or changes the tab's site permissions as an agent, answered by a
   * `permission` event with the same `requestId`. `origin` defaults to the
   * origin the tab shows; the desktop refuses to override a person's Block.
   */
  Schema.Struct({
    type: Schema.Literal("permission"),
    ...TabKey,
    requestId: Schema.String,
    change: Schema.NullOr(
      Schema.Struct({
        permission: SitePermission,
        setting: SitePermissionSetting,
        origin: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
