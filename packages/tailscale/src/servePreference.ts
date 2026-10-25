/**
 * The saved Tailscale Serve preference: whether Serve fronts this Cogenly
 * server, kept in `tailscale-serve.json` in the server's state directory.
 * Private access on Settings → Machines writes it, and so do `cogenly service
 * install --tailscale-serve` and `cogenly doctor`. The server reads it on
 * every start; the desktop app reads it to advertise the tailnet URL.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const TAILSCALE_SERVE_PREFERENCE_FILE = "tailscale-serve.json";

export const TailscaleServePreference = Schema.Struct({
  enabled: Schema.Boolean,
  servePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  /** The local port Serve last pointed at, so a later run can repoint its own mapping. */
  localPort: Schema.optionalKey(Schema.Int),
});
export type TailscaleServePreference = typeof TailscaleServePreference.Type;

const PreferenceJson = Schema.fromJsonString(TailscaleServePreference);
const decodePreference = Schema.decodeUnknownEffect(PreferenceJson);
const encodePreference = Schema.encodeEffect(PreferenceJson);

/** The saved preference; none when unset or unreadable. */
export const readServePreference = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return Option.none<TailscaleServePreference>();
    return Option.some(yield* decodePreference(yield* fs.readFileString(filePath)));
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Ignoring an unreadable Tailscale Serve preference", { cause }).pipe(
        Effect.as(Option.none<TailscaleServePreference>()),
      ),
    ),
  );

export const writeServePreference = (filePath: string, preference: TailscaleServePreference) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    yield* fs.writeFileString(temporary, `${yield* encodePreference(preference)}\n`);
    yield* fs.rename(temporary, filePath);
  });

/**
 * Carries a retired Tailscale switch (the desktop app's Tailscale HTTPS) into
 * the saved preference: on turns Serve on at that HTTPS port, keeping the
 * saved local port; off or absent leaves the preference as it is. Returns
 * whether it wrote.
 */
export const adoptLegacyServePreference = (
  filePath: string,
  legacy: { readonly enabled: boolean; readonly servePort: number } | undefined,
) =>
  Effect.gen(function* () {
    if (legacy === undefined || !legacy.enabled) return false;
    const saved = yield* readServePreference(filePath);
    yield* writeServePreference(filePath, {
      ...Option.getOrUndefined(saved),
      enabled: true,
      servePort: legacy.servePort,
    });
    return true;
  });
