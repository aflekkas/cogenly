import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  parseMuseUsageLimits,
  parseMuseUsageReadResponse,
  readCachedMuseUsageLimits,
} from "./usageLimits.ts";

const observation = {
  observedAtMs: 1_792_166_400_000,
  tier: "pro",
  window: { usedPercent: 23, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
  weekly: { usedPercent: 47, resetsAtMs: 1_792_771_200_000 },
};

describe("Muse subscription limits", () => {
  it("maps real session and weekly windows and preserves observation/reset times", () => {
    const limits = parseMuseUsageLimits(observation);
    expect(limits?.checkedAt).toBe(
      DateTime.formatIso(DateTime.makeUnsafe(observation.observedAtMs)),
    );
    expect(limits?.windows).toEqual([
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: 23,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.window.resetsAtMs)),
        windowDurationMins: 300,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 47,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(observation.weekly.resetsAtMs)),
        windowDurationMins: 10080,
      },
    ]);
  });
  it("bounds over-quota values for bars without inventing missing observations", () => {
    expect(
      parseMuseUsageLimits({ ...observation, window: { ...observation.window, usedPercent: 120 } })
        ?.windows[0]?.usedPercent,
    ).toBe(100);
    for (const value of [
      undefined,
      {},
      { usedTokens: 42, windowTokens: 100 },
      { ...observation, weekly: { usedPercent: -1, resetsAtMs: 100 } },
      { ...observation, observedAtMs: NaN },
      { ...observation, window: { ...observation.window, windowDurationMins: 0 } },
    ]) {
      expect(parseMuseUsageLimits(value)).toBeUndefined();
    }
  });

  it("parses the usage/read envelope and treats an empty result as unobserved", () => {
    expect(parseMuseUsageReadResponse({ usage: observation })).toEqual(
      parseMuseUsageLimits(observation),
    );
    expect(parseMuseUsageReadResponse({})).toBeUndefined();
    expect(parseMuseUsageReadResponse(undefined)).toBeUndefined();
  });
});

describe("readCachedMuseUsageLimits", () => {
  const instanceId = ProviderInstanceId.make("muse");
  const writeCache = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "muse-limits-cache-" });
    const provider = {
      instanceId: "muse",
      driver: "muse",
      enabled: true,
      installed: true,
      version: "1.4.11",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(observation.observedAtMs)),
      models: [],
      usageLimits: parseMuseUsageLimits(observation),
    };
    yield* fileSystem.writeFileString(path.join(dir, "muse.json"), `${JSON.stringify(provider)}\n`);
    return dir;
  });

  it.effect("returns last-known windows and drops them as their resets pass", () =>
    Effect.gen(function* () {
      const dir = yield* writeCache;
      yield* TestClock.setTime(observation.observedAtMs);
      const atObservation = yield* readCachedMuseUsageLimits(dir, instanceId);
      expect(atObservation?.windows.map((window) => window.id)).toEqual(["window", "weekly"]);

      yield* TestClock.setTime(observation.window.resetsAtMs + 1);
      const afterSessionReset = yield* readCachedMuseUsageLimits(dir, instanceId);
      expect(afterSessionReset?.windows.map((window) => window.id)).toEqual(["weekly"]);

      yield* TestClock.setTime(observation.weekly.resetsAtMs + 1);
      expect(yield* readCachedMuseUsageLimits(dir, instanceId)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a missing file and another instance's cache", () =>
    Effect.gen(function* () {
      const dir = yield* writeCache;
      yield* TestClock.setTime(observation.observedAtMs);
      expect(
        yield* readCachedMuseUsageLimits(dir, ProviderInstanceId.make("muse_work")),
      ).toBeUndefined();
      expect(yield* readCachedMuseUsageLimits("/definitely/missing", instanceId)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
