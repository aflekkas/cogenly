import { AppearanceAccentSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDockIcon from "../../app/DesktopDockIcon.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * The renderer's accent (Settings → Appearance). Every window sends it on load
 * and on change; only a new value touches the Dock and the settings file, which
 * keeps it for the next launch (DesktopApp restores it once the app is ready).
 */
export const setAccentColor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_ACCENT_COLOR_CHANNEL,
  payload: AppearanceAccentSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.accentColor.set")(function* (accent) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    if ((yield* appSettings.get).accentColor === accent) return;
    yield* DesktopDockIcon.applyAccentDockIcon(accent);
    yield* appSettings.setAccentColor(accent);
  }),
});
