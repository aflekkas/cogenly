/**
 * TailscaleServeMode: whether Tailscale Serve fronts this server, so peer
 * ingress accepts Serve's forwarded requests and pairing advertises the
 * tailnet URL. `--tailscale-serve` (or `COGENLY_TAILSCALE_SERVE`) sets it for
 * one run. Otherwise it lives in `tailscale-serve.json` in the state
 * directory, written by machine setup, `cogenly service install
 * --tailscale-serve`, or `cogenly doctor`. The server reads it on every start,
 * however it is launched (desktop app, launchd, systemd), and setup changes it
 * live without a restart.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { DEFAULT_TAILSCALE_SERVE_PORT } from "@t3tools/tailscale";

import * as ServerConfig from "../config.ts";

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

export const servePreferencePath = Effect.fn("TailscaleServeMode.preferencePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, TAILSCALE_SERVE_PREFERENCE_FILE);
});

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

export type TailscaleServeModeState = TailscaleServePreference;

export class TailscaleServeMode extends Context.Service<
  TailscaleServeMode,
  {
    readonly current: Effect.Effect<TailscaleServeModeState>;
    /**
     * Started with `--tailscale-serve`: the flag owns the setting for this
     * run, and the server turns its mapping off again at shutdown.
     */
    readonly explicit: boolean;
    /** Takes effect at once and is saved for the next start. */
    readonly set: (state: TailscaleServeModeState) => Effect.Effect<void>;
  }
>()("cogenly-server/tailscale/TailscaleServeMode") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = yield* servePreferencePath(config.stateDir).pipe(
    Effect.provideService(Path.Path, path),
  );
  const saved = yield* readServePreference(filePath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const explicit = config.tailscaleServeEnabled;
  const state = yield* Ref.make<TailscaleServeModeState>(
    explicit
      ? {
          ...Option.getOrUndefined(saved),
          enabled: true,
          servePort: config.tailscaleServePort,
        }
      : Option.getOrElse(saved, () => ({
          enabled: false,
          servePort: DEFAULT_TAILSCALE_SERVE_PORT,
        })),
  );
  const set: TailscaleServeMode["Service"]["set"] = (next) =>
    Ref.set(state, next).pipe(
      Effect.andThen(
        writeServePreference(filePath, next).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.catch((cause) =>
            Effect.logWarning("Could not save the Tailscale Serve preference", { cause }),
          ),
        ),
      ),
      Effect.withSpan("TailscaleServeMode.set"),
    );
  return TailscaleServeMode.of({ current: Ref.get(state), explicit, set });
});

export const layer = Layer.effect(TailscaleServeMode, make);

/** For tests and callers that hold no state directory. */
export const layerMemory = (initial: TailscaleServeModeState, explicit = false) =>
  Layer.effect(
    TailscaleServeMode,
    Effect.map(Ref.make(initial), (state) =>
      TailscaleServeMode.of({
        current: Ref.get(state),
        explicit,
        set: (next) => Ref.set(state, next),
      }),
    ),
  );
