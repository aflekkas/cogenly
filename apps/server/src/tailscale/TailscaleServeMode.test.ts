import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as TailscaleServeMode from "./TailscaleServeMode.ts";

/** A server config in a fresh state directory, with `--tailscale-serve` on or off. */
const configLayer = (tailscaleServeEnabled: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      tailscaleServeEnabled,
      tailscaleServePort: 8443,
    })),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-serve-mode-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const savedPreference = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const filePath = yield* TailscaleServeMode.servePreferencePath(config.stateDir);
  return yield* TailscaleServeMode.readServePreference(filePath);
});

describe("TailscaleServeMode", () => {
  it.effect("saves what setup turns on for the next start", () =>
    Effect.gen(function* () {
      const mode = yield* TailscaleServeMode.TailscaleServeMode;
      yield* mode.set({ enabled: true, servePort: 443, localPort: 3773 });
      assert.deepEqual(Option.getOrNull(yield* savedPreference), {
        enabled: true,
        servePort: 443,
        localPort: 3773,
      });
    }).pipe(Effect.provide(TailscaleServeMode.layer.pipe(Layer.provideMerge(configLayer(false))))),
  );

  it.effect("keeps a --tailscale-serve run's setup out of the saved setting", () =>
    Effect.gen(function* () {
      const mode = yield* TailscaleServeMode.TailscaleServeMode;
      assert.deepEqual(yield* mode.current, { enabled: true, servePort: 8443 });
      yield* mode.set({ enabled: true, servePort: 8443, localPort: 3773 });
      assert.isTrue(Option.isNone(yield* savedPreference));
    }).pipe(Effect.provide(TailscaleServeMode.layer.pipe(Layer.provideMerge(configLayer(true))))),
  );

  it.effect("reads a saved off as the user's opt-out", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const filePath = yield* TailscaleServeMode.servePreferencePath(config.stateDir);
      yield* TailscaleServeMode.writeServePreference(filePath, { enabled: false, servePort: 443 });
      const mode = yield* TailscaleServeMode.make;
      assert.isTrue(yield* mode.optedOut);
      yield* mode.set({ enabled: true, servePort: 443, localPort: 3773 });
      assert.isFalse(yield* mode.optedOut);
    }).pipe(Effect.provide(configLayer(false))),
  );
});
