import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseMuseUsageLimits } from "./usageLimits.ts";
import {
  readCachedMuseUsageLimits,
  resolveMuseUsageLimitsCachePath,
  writeCachedMuseUsageLimits,
} from "./usageLimitsCache.ts";

const observation = {
  observedAtMs: 1_792_166_400_000,
  tier: "pro",
  window: { usedPercent: 23, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
  weekly: { usedPercent: 47, resetsAtMs: 1_792_771_200_000 },
};

const limits = parseMuseUsageLimits(observation)!;

it.layer(NodeServices.layer)("Muse usage limits cache", (it) => {
  it.effect("resolves one cache file per instance under the cache dir", () =>
    Effect.gen(function* () {
      const filePath = yield* resolveMuseUsageLimitsCachePath({
        cacheDir: "/cache",
        instanceId: ProviderInstanceId.make("muse_work"),
      });
      expect(filePath).toBe("/cache/muse-usage-limits/muse_work.json");
    }),
  );

  it.effect("round-trips written limits with the observation time intact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-limits-cache-" });
        const filePath = `${directory}/muse.json`;
        yield* writeCachedMuseUsageLimits(filePath, limits);
        expect(yield* readCachedMuseUsageLimits(filePath)).toEqual(limits);
      }),
    ),
  );

  it.effect("reads a missing or corrupt cache as no observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-limits-cache-" });
        expect(yield* readCachedMuseUsageLimits(`${directory}/missing.json`)).toBeUndefined();
        const corrupt = `${directory}/corrupt.json`;
        yield* fs.writeFileString(corrupt, "{not json");
        expect(yield* readCachedMuseUsageLimits(corrupt)).toBeUndefined();
        const wrongShape = `${directory}/wrong-shape.json`;
        yield* fs.writeFileString(wrongShape, JSON.stringify({ usage: { tier: "pro" } }));
        expect(yield* readCachedMuseUsageLimits(wrongShape)).toBeUndefined();
      }),
    ),
  );

  it.effect("never persists an unavailable snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-limits-cache-" });
        const filePath = `${directory}/muse.json`;
        yield* writeCachedMuseUsageLimits(filePath, {
          ...limits,
          windows: [],
          unavailable: { reason: "probeFailed" },
        });
        expect(yield* fs.exists(filePath)).toBe(false);
        // A hand-written unavailable snapshot still reads as no observation.
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({ ...limits, windows: [], unavailable: { reason: "probeFailed" } }),
        );
        expect(yield* readCachedMuseUsageLimits(filePath)).toBeUndefined();
      }),
    ),
  );
});
