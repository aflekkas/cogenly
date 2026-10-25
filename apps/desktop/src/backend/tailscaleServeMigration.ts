import { adoptLegacyServePreference } from "@cogenly/tailscale";
import * as Effect from "effect/Effect";

/**
 * The desktop app's own Tailscale HTTPS switch is retired: Private access on
 * Settings → Machines is the only Tailscale switch, saved in the backend's
 * `tailscale-serve.json`. Before the backend starts, a desktop switch left on
 * moves into that file, so private access stays on, and only then is the
 * desktop copy cleared. A failed write leaves the desktop copy to retry on the
 * next start. Returns whether it moved anything.
 */
export const migrateDesktopTailscaleServe = Effect.fn("desktop.migrateTailscaleServe")(function* <
  E,
  R,
>(input: {
  readonly legacy: { readonly enabled: boolean; readonly servePort: number };
  readonly preferencePath: string;
  readonly clearLegacy: Effect.Effect<unknown, E, R>;
}) {
  const moved = yield* adoptLegacyServePreference(input.preferencePath, input.legacy);
  if (moved) yield* input.clearLegacy;
  return moved;
});
