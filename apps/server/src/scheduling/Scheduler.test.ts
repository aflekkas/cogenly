import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { lastSchedulerTickAtMs, layer } from "./Scheduler.ts";

describe("scheduler heartbeat", () => {
  it.effect("advances on every tick", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        const first = yield* lastSchedulerTickAtMs;
        expect(first).not.toBeNull();
        yield* TestClock.adjust("5 seconds");
        yield* Effect.yieldNow;
        const second = yield* lastSchedulerTickAtMs;
        expect(second).toBeGreaterThan(first ?? 0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
