import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { readServePreference, writeServePreference } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { migrateDesktopTailscaleServe } from "./tailscaleServeMigration.ts";

/** Runs one migration against a fresh state directory. */
const migrate = (input: {
  readonly legacy: { readonly enabled: boolean; readonly servePort: number };
  readonly saved?: { readonly enabled: boolean; readonly servePort: number; localPort?: number };
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-serve-migration-" });
    const preferencePath = path.join(stateDir, "tailscale-serve.json");
    if (input.saved) yield* writeServePreference(preferencePath, input.saved);
    const cleared = yield* Ref.make(false);
    const moved = yield* migrateDesktopTailscaleServe({
      legacy: input.legacy,
      preferencePath,
      clearLegacy: Ref.set(cleared, true),
    });
    return {
      moved,
      cleared: yield* Ref.get(cleared),
      saved: Option.getOrNull(yield* readServePreference(preferencePath)),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("migrateDesktopTailscaleServe", () => {
  it.effect("turns private access on when the desktop switch was on, then clears it", () =>
    Effect.gen(function* () {
      const result = yield* migrate({ legacy: { enabled: true, servePort: 8443 } });
      assert.deepEqual(result, {
        moved: true,
        cleared: true,
        saved: { enabled: true, servePort: 8443 },
      });
    }),
  );

  it.effect("overrides a saved opt-out and keeps the saved local port", () =>
    Effect.gen(function* () {
      const result = yield* migrate({
        legacy: { enabled: true, servePort: 443 },
        saved: { enabled: false, servePort: 8443, localPort: 3773 },
      });
      assert.deepEqual(result.saved, { enabled: true, servePort: 443, localPort: 3773 });
    }),
  );

  it.effect("leaves private access alone when the desktop switch was off", () =>
    Effect.gen(function* () {
      const absent = yield* migrate({ legacy: { enabled: false, servePort: 443 } });
      assert.deepEqual(absent, { moved: false, cleared: false, saved: null });

      const saved = { enabled: true, servePort: 8443, localPort: 3773 };
      const kept = yield* migrate({ legacy: { enabled: false, servePort: 443 }, saved });
      assert.deepEqual(kept, { moved: false, cleared: false, saved });
    }),
  );
});
