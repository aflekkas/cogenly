/**
 * TailscaleServeMode: whether Tailscale Serve fronts this server, so peer
 * ingress accepts Serve's forwarded requests and pairing advertises the
 * tailnet URL. `--tailscale-serve` (or `COGENLY_TAILSCALE_SERVE`) sets it for
 * one run. Otherwise it lives in `tailscale-serve.json` in the state
 * directory (see `@cogenly/tailscale`'s servePreference), written by machine
 * setup (Private access), `cogenly service install --tailscale-serve`, or
 * `cogenly doctor`. The server reads it on every start,
 * however it is launched (desktop app, launchd, systemd), and setup changes it
 * live without a restart. A saved `enabled: false` is an opt-out: a Serve
 * mapping left running is not adopted again.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  DEFAULT_TAILSCALE_SERVE_PORT,
  readServePreference,
  TAILSCALE_SERVE_PREFERENCE_FILE,
  type TailscaleServePreference,
  writeServePreference,
} from "@cogenly/tailscale";

import * as ServerConfig from "../config.ts";

export {
  readServePreference,
  TAILSCALE_SERVE_PREFERENCE_FILE,
  TailscaleServePreference,
  writeServePreference,
} from "@cogenly/tailscale";

export const servePreferencePath = Effect.fn("TailscaleServeMode.preferencePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, TAILSCALE_SERVE_PREFERENCE_FILE);
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
    /**
     * The user turned Serve off (`cogenly service install --no-tailscale-serve`,
     * or a migrated drop-in that set it off), so a mapping still running is not
     * adopted. Running a setup step turns it back on.
     */
    readonly optedOut: Effect.Effect<boolean>;
    /**
     * Takes effect at once and is saved for the next start, except under
     * `--tailscale-serve`, which owns the setting for this run only.
     */
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
  // Setup only ever saves `enabled: true`, so a saved `false` is the user's choice.
  const optedOut = yield* Ref.make(!explicit && Option.isSome(saved) && !saved.value.enabled);
  const set: TailscaleServeMode["Service"]["set"] = (next) =>
    Ref.set(state, next).pipe(
      Effect.andThen(Ref.set(optedOut, !next.enabled)),
      Effect.andThen(
        explicit
          ? Effect.void
          : writeServePreference(filePath, next).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.catch((cause) =>
                Effect.logWarning("Could not save the Tailscale Serve preference", { cause }),
              ),
            ),
      ),
      Effect.withSpan("TailscaleServeMode.set"),
    );
  return TailscaleServeMode.of({
    current: Ref.get(state),
    explicit,
    optedOut: Ref.get(optedOut),
    set,
  });
});

export const layer = Layer.effect(TailscaleServeMode, make);

/** For tests and callers that hold no state directory. */
export const layerMemory = (
  initial: TailscaleServeModeState,
  options: { readonly explicit?: boolean; readonly optedOut?: boolean } = {},
) =>
  Layer.effect(
    TailscaleServeMode,
    Effect.gen(function* () {
      const state = yield* Ref.make(initial);
      const optedOut = yield* Ref.make(options.optedOut ?? false);
      return TailscaleServeMode.of({
        current: Ref.get(state),
        explicit: options.explicit ?? false,
        optedOut: Ref.get(optedOut),
        set: (next) => Ref.set(state, next).pipe(Effect.andThen(Ref.set(optedOut, !next.enabled))),
      });
    }),
  );
