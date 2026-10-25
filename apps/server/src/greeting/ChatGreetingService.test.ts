import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { TextGenerationError, type ChatGreetingInput } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Greetings from "./ChatGreetingService.ts";

// A Sunday morning, UTC.
const NOW = Date.parse("2026-10-25T09:30:00Z");
const HOUR = 60 * 60 * 1_000;
const morning: ChatGreetingInput = {
  day: "2026-10-25",
  bucket: "morning",
  weekday: 0,
  awaitGeneration: true,
};
const recentThreads = [{ title: "Spot pricing page", projectTitle: "spot" }];

const makeLayer = (options: {
  readonly generate: TextGeneration.TextGeneration["Service"]["generateGreeting"];
  readonly baseDir?: string;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly threads?: ReadonlyArray<{
    readonly title: string;
    readonly projectTitle: string | null;
  }>;
}) =>
  Greetings.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({ generateGreeting: options.generate }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecentThreadTitles: () => Effect.succeed(options.threads ?? recentThreads),
        }),
        ServerSettings.layerTest(options.settings),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest("/tmp", options.baseDir ?? { prefix: "cogenly-greeting-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A generator that answers `text` and records every prompt it was asked for. */
const counting = (text: string) => {
  const calls: Array<{ readonly weekday: string; readonly timeOfDay: string }> = [];
  const generate: TextGeneration.TextGeneration["Service"]["generateGreeting"] = (input) =>
    Effect.sync(() => {
      calls.push({ weekday: input.weekday, timeOfDay: input.timeOfDay });
      return { greeting: text };
    });
  return { calls, generate };
};

describe("decideGreeting", () => {
  const base = { enabled: true, request: morning, entries: [], nowMs: NOW };

  it("generates once per day and bucket, then answers from the entry", () => {
    expect(Greetings.decideGreeting(base)).toEqual({ type: "generate" });
    const entries = [{ key: Greetings.greetingKey(morning), text: "Hi", at: NOW }];
    expect(Greetings.decideGreeting({ ...base, entries })).toEqual({ type: "cached", text: "Hi" });
    // A failed attempt is remembered too, so the bucket is not retried.
    const failed = [{ key: Greetings.greetingKey(morning), text: null, at: NOW }];
    expect(Greetings.decideGreeting({ ...base, entries: failed })).toEqual({
      type: "cached",
      text: null,
    });
  });

  it("skips when off, late at night, on an implausible day, or past the daily budget", () => {
    expect(Greetings.decideGreeting({ ...base, enabled: false })).toEqual({ type: "skip" });
    expect(
      Greetings.decideGreeting({ ...base, request: { ...morning, bucket: "lateNight" } }),
    ).toEqual({ type: "skip" });
    expect(
      Greetings.decideGreeting({ ...base, request: { ...morning, day: "2026-10-28" } }),
    ).toEqual({ type: "skip" });
    const spent = Array.from({ length: Greetings.MAX_GREETING_ATTEMPTS_PER_DAY }, (_, index) => ({
      key: `2026-10-24:other-${index}`,
      text: "Hi",
      at: NOW - (index + 1) * HOUR,
    }));
    expect(Greetings.decideGreeting({ ...base, entries: spent })).toEqual({ type: "skip" });
    // Attempts older than a day no longer count.
    const old = spent.map((entry) => ({ ...entry, at: entry.at - 24 * HOUR }));
    expect(Greetings.decideGreeting({ ...base, entries: old })).toEqual({ type: "generate" });
  });
});

describe("rememberGreeting", () => {
  it("replaces an entry for the same key and keeps only the newest", () => {
    const entries = Array.from({ length: 14 }, (_, index): Greetings.GreetingEntry => ({
      key: `day-${index}`,
      text: null,
      at: index,
    }));
    const next = Greetings.rememberGreeting(entries, { key: "day-13", text: "Hi", at: 20 });
    expect(next).toHaveLength(12);
    expect(next.at(-1)).toEqual({ key: "day-13", text: "Hi", at: 20 });
    expect(next.filter((entry) => entry.key === "day-13")).toHaveLength(1);
  });
});

describe("cleanGreeting", () => {
  it("keeps one unquoted line and drops empty or overlong answers", () => {
    expect(Greetings.cleanGreeting('  "Morning. More work on spot?"\n')).toBe(
      "Morning. More work on spot?",
    );
    expect(Greetings.cleanGreeting("   ")).toBeNull();
    expect(Greetings.cleanGreeting("x".repeat(81))).toBeNull();
  });
});

describe("summarizeRecentWork", () => {
  it("dedupes titles and skips untitled threads", () => {
    expect(
      Greetings.summarizeRecentWork([
        { title: "Spot pricing page", projectTitle: "spot" },
        { title: "Spot pricing page", projectTitle: "spot" },
        { title: "New thread", projectTitle: null },
      ]),
    ).toEqual({ threads: ["Spot pricing page"], projects: ["spot"] });
  });
});

describe("ChatGreetingService.get", () => {
  it.effect("writes one greeting per bucket and reuses it on later requests", () => {
    const model = counting("Sunday morning. More work on spot?");
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* Greetings.ChatGreetingService;
      expect(yield* service.get(morning)).toEqual({
        text: "Sunday morning. More work on spot?",
        pending: false,
      });
      expect(yield* service.get({ ...morning, awaitGeneration: false })).toEqual({
        text: "Sunday morning. More work on spot?",
        pending: false,
      });
      expect(model.calls).toEqual([{ weekday: "Sunday", timeOfDay: "morning" }]);

      // A new bucket is a new greeting.
      yield* TestClock.setTime(NOW + 5 * HOUR);
      yield* service.get({ ...morning, bucket: "afternoon" });
      expect(model.calls).toHaveLength(2);
    }).pipe(Effect.provide(makeLayer({ generate: model.generate })));
  });

  it.effect("answers pending first, and concurrent requests share one generation", () => {
    const model = counting("Morning. Back to spot?");
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* Greetings.ChatGreetingService;
      expect(yield* service.get({ ...morning, awaitGeneration: false })).toEqual({
        text: null,
        pending: true,
      });
      const [left, right] = yield* Effect.all([service.get(morning), service.get(morning)], {
        concurrency: "unbounded",
      });
      expect(left).toEqual({ text: "Morning. Back to spot?", pending: false });
      expect(right).toEqual(left);
      expect(model.calls).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer({ generate: model.generate })));
  });

  it.effect("keeps a greeting across a restart", () => {
    const first = counting("Morning. More work on spot?");
    const second = counting("Something else");
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const config = yield* ServerConfig.ServerConfig;
      yield* (yield* Greetings.ChatGreetingService).get(morning);
      const afterRestart = yield* Effect.gen(function* () {
        return yield* (yield* Greetings.ChatGreetingService).get(morning);
      }).pipe(Effect.provide(makeLayer({ generate: second.generate, baseDir: config.baseDir })));
      expect(afterRestart).toEqual({ text: "Morning. More work on spot?", pending: false });
      expect(second.calls).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer({ generate: first.generate })));
  });

  it.effect("makes no call when greetings are off", () => {
    const model = counting("Should not appear");
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* Greetings.ChatGreetingService;
      expect(yield* service.get(morning)).toEqual({ text: null, pending: false });
      expect(model.calls).toHaveLength(0);
    }).pipe(
      Effect.provide(makeLayer({ generate: model.generate, settings: { aiGreetings: false } })),
    );
  });

  it.effect("makes no call without recent work", () => {
    const model = counting("Should not appear");
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* Greetings.ChatGreetingService;
      expect(yield* service.get(morning)).toEqual({ text: null, pending: false });
      expect(model.calls).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer({ generate: model.generate, threads: [] })));
  });

  it.effect("falls back to the built-in line when generation fails, without retrying", () => {
    let calls = 0;
    const generate: TextGeneration.TextGeneration["Service"]["generateGreeting"] = () =>
      Effect.suspend(() => {
        calls += 1;
        return Effect.fail(
          new TextGenerationError({ operation: "generateThreadTitle", detail: "No provider." }),
        );
      });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* Greetings.ChatGreetingService;
      expect(yield* service.get(morning)).toEqual({ text: null, pending: false });
      expect(yield* service.get(morning)).toEqual({ text: null, pending: false });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(makeLayer({ generate })));
  });
});
