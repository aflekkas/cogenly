import type { AppearanceAccent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * The macOS Dock icon follows the web client's accent (Settings → Appearance).
 * Each non-orange accent has a pre-rendered variant in resources/dock-icons,
 * written by scripts/render-accent-dock-icons.ts from the Cogenly mark. The
 * bundle icon (Finder, and the Dock until the app is ready) stays orange: macOS
 * reads it from Info.plist, so only the running app's tile can change.
 */
export function accentDockIconResource(accent: Exclude<AppearanceAccent, "orange">): string {
  return `dock-icons/${accent}.png`;
}

/** Sets the Dock icon for `accent`; orange (or a missing variant) restores the default. */
export const applyAccentDockIcon = Effect.fn("desktop.dockIcon.applyAccent")(function* (
  accent: AppearanceAccent,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin") return;
  const electronApp = yield* ElectronApp.ElectronApp;
  const assets = yield* DesktopAssets.DesktopAssets;

  if (accent !== "orange") {
    const iconPath = yield* assets
      .resolveResourcePath(accentDockIconResource(accent))
      .pipe(Effect.orElseSucceed(() => Option.none<string>()));
    if (Option.isSome(iconPath)) {
      yield* electronApp.setDockIcon(iconPath.value);
      return;
    }
    yield* Effect.logWarning("accent dock icon missing; showing the default", { accent });
  }

  // A packaged bundle's own icon comes back by clearing the override, which
  // also keeps a custom icon the user attached to the app. Unpackaged runs set
  // their channel icon explicitly (DesktopAppIdentity), so put that back.
  if (environment.isPackaged && (yield* electronApp.resetDockIcon)) return;
  const { png } = yield* assets.iconPaths;
  if (Option.isSome(png)) yield* electronApp.setDockIcon(png.value);
});

/** On launch, once the app is ready: the persisted accent, if it is not the default. */
export const restoreAccentDockIcon = Effect.fn("desktop.dockIcon.restore")(function* (
  accent: AppearanceAccent,
) {
  if (accent === "orange") return;
  yield* applyAccentDockIcon(accent);
});
