import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { MuseSettings } from "../settings.ts";
import {
  expireResetLimitsWindows,
  extractBumpObservation,
  makeMuseLimitsBumpController,
  museBumpMinIntervalMs,
  MUSE_BUMP_ATTEMPT_COOLDOWN_MS,
  MUSE_BUMP_PROMPT,
  runMuseLimitsBump,
  selectBumpModelId,
  selectBumpReasoningEffort,
  shouldBumpMuseLimits,
} from "./limitsBump.ts";
import type { MuseSdkHost, MuseSdkHostOptions } from "./sdk.ts";
import { parseMuseUsageLimits, readMuseUsageLimits } from "./usageLimits.ts";
import { readCachedMuseUsageLimits, writeCachedMuseUsageLimits } from "./usageLimitsCache.ts";

const decodeSettings = Schema.decodeSync(MuseSettings);

const model = (
  slug: string,
  options: { readonly isDefault?: boolean; readonly minimalEffort?: boolean } = {},
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  ...(options.isDefault ? { isDefault: true } : {}),
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          ...(options.minimalEffort === false ? [] : [{ id: "minimal", label: "Minimal" }]),
          { id: "high", label: "High" },
        ],
      },
    ],
  },
});

/** The live catalog order: wonder rows first, spark rows last. */
const liveCatalog = [
  model("muse-wonder-1.0", { isDefault: true }),
  model("muse-wonder-full-1.0"),
  model("muse-spark-1.3"),
  model("muse-spark-1.2"),
];

const observation = {
  observedAtMs: 1_792_166_400_000,
  tier: "pro",
  window: { usedPercent: 21, resetsAtMs: 1_792_184_400_000, windowDurationMins: 300 },
  weekly: { usedPercent: 42, resetsAtMs: 1_792_771_200_000 },
};

const makeBumpHost = (behavior: {
  readonly observation?: unknown;
  readonly failTurn?: boolean;
  readonly hangTurn?: boolean;
  readonly turnGate?: Promise<void>;
}) => {
  let notify: (notification: { method: string; params: unknown }) => void = () => {};
  const seen: Array<{ readonly method: string; readonly params: unknown }> = [];
  const host: MuseSdkHost = {
    initializeResult: {
      grantedCapabilities: [],
      serverInfo: { name: "muse", version: "1.4.11" },
    },
    connection: {
      request: async (method: string, params?: Record<string, unknown>) => {
        seen.push({ method, params });
        if (method === "session/start") return { session: { sessionId: "bump-session" } };
        if (method === "turn/start") {
          if (behavior.failTurn) throw new Error("bump turn rejected");
          if (behavior.turnGate) await behavior.turnGate;
          if (!behavior.hangTurn) {
            if (behavior.observation !== undefined) {
              notify({ method: "usage/changed", params: behavior.observation });
            }
            notify({ method: "turn/completed", params: { terminal: "completed" } });
          }
          return { turnId: "bump-turn" };
        }
        if (method === "usage/read") {
          return behavior.observation === undefined ? {} : { usage: behavior.observation };
        }
        return {};
      },
      command: async () => ({}),
      mintCommandId: () => `cmd-${seen.length}`,
      onNotification: (handler) => {
        notify = handler as (notification: { method: string; params: unknown }) => void;
      },
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return { host, seen };
};

it("runs the bump on the cheapest catalog model behind a minimal prompt", () => {
  expect(selectBumpModelId(liveCatalog, "")).toBe("muse-spark-1.2");
  expect(selectBumpModelId(liveCatalog, "muse-wonder-1.0")).toBe("muse-wonder-1.0");
  expect(selectBumpModelId(liveCatalog, "muse-retired-9.9")).toBe("muse-spark-1.2");
  expect(selectBumpModelId([], "")).toBeUndefined();
  // Unknown families rank with the flagship tier: lowest version wins, catalog order breaks ties.
  expect(selectBumpModelId([model("muse-nova-2.0"), model("muse-wonder-1.0")], "")).toBe(
    "muse-wonder-1.0",
  );
  expect(selectBumpModelId([model("muse-nova-1.0"), model("muse-wonder-1.0")], "")).toBe(
    "muse-nova-1.0",
  );
  expect(MUSE_BUMP_PROMPT).toBe("Reply with exactly: OK");
});

it("asks for minimal reasoning only when the model advertises it", () => {
  expect(selectBumpReasoningEffort(model("muse-spark-1.2"))).toBe("minimal");
  expect(selectBumpReasoningEffort(model("muse-spark-1.2", { minimalEffort: false }))).toBe(
    undefined,
  );
  expect(selectBumpReasoningEffort(undefined)).toBeUndefined();
  expect(selectBumpReasoningEffort({ capabilities: null })).toBeUndefined();
});

it("reads the refresh interval in minutes with a 30-minute fallback", () => {
  expect(museBumpMinIntervalMs("30")).toBe(30 * 60_000);
  expect(museBumpMinIntervalMs("5")).toBe(5 * 60_000);
  expect(museBumpMinIntervalMs("garbage")).toBe(30 * 60_000);
  expect(museBumpMinIntervalMs("0")).toBe(30 * 60_000);
});

it("bumps on missing, stale, or reset-passed observations, never on fresh ones", () => {
  const base = {
    autoRefresh: true,
    minIntervalMs: 30 * 60_000,
    attemptCooldownMs: MUSE_BUMP_ATTEMPT_COOLDOWN_MS,
    lastAttemptMs: undefined,
    lastSuccessMs: undefined,
  } as const;
  const nowMs = 1_792_200_000_000;
  expect(
    shouldBumpMuseLimits({
      ...base,
      nowMs,
      observation: { observedAtMs: undefined, resetsAtMs: [] },
    }),
  ).toBe(true);
  expect(
    shouldBumpMuseLimits({
      ...base,
      nowMs,
      observation: { observedAtMs: nowMs - 60_000, resetsAtMs: [nowMs + 60_000] },
    }),
  ).toBe(false);
  expect(
    shouldBumpMuseLimits({
      ...base,
      nowMs,
      observation: { observedAtMs: nowMs - 31 * 60_000, resetsAtMs: [nowMs + 60_000] },
    }),
  ).toBe(true);
  // A reset that passed makes even a fresh observation stale.
  expect(
    shouldBumpMuseLimits({
      ...base,
      nowMs,
      observation: { observedAtMs: nowMs - 60_000, resetsAtMs: [nowMs - 1_000] },
    }),
  ).toBe(true);
});

it("treats the toggle, cooldowns, and recent bumps as vetoes", () => {
  const stale = { observedAtMs: 1_000, resetsAtMs: [] as ReadonlyArray<number> };
  const nowMs = 1_792_200_000_000;
  const base = {
    nowMs,
    minIntervalMs: 30 * 60_000,
    attemptCooldownMs: MUSE_BUMP_ATTEMPT_COOLDOWN_MS,
    observation: stale,
  } as const;
  expect(
    shouldBumpMuseLimits({
      ...base,
      autoRefresh: false,
      lastAttemptMs: undefined,
      lastSuccessMs: undefined,
    }),
  ).toBe(false);
  // A recent attempt cools down even a missing observation.
  expect(
    shouldBumpMuseLimits({
      ...base,
      autoRefresh: true,
      lastAttemptMs: nowMs - 1_000,
      lastSuccessMs: undefined,
    }),
  ).toBe(false);
  expect(
    shouldBumpMuseLimits({
      ...base,
      autoRefresh: true,
      lastAttemptMs: nowMs - MUSE_BUMP_ATTEMPT_COOLDOWN_MS - 1,
      lastSuccessMs: undefined,
    }),
  ).toBe(true);
  // A recent success counts as fresh even when the stamp itself is old: the
  // host only mints a new observation when the numbers move.
  expect(
    shouldBumpMuseLimits({
      ...base,
      autoRefresh: true,
      lastAttemptMs: nowMs - 60_000,
      lastSuccessMs: nowMs - 60_000,
    }),
  ).toBe(false);
});

it("reduces served limits to trigger numbers and zeroes reset windows", () => {
  const limits = parseMuseUsageLimits(observation)!;
  expect(extractBumpObservation(limits)).toEqual({
    observedAtMs: observation.observedAtMs,
    resetsAtMs: [observation.window.resetsAtMs, observation.weekly.resetsAtMs],
  });
  expect(extractBumpObservation(undefined)).toEqual({ observedAtMs: undefined, resetsAtMs: [] });
  const expired = expireResetLimitsWindows(limits, observation.window.resetsAtMs + 1);
  expect(expired.windows.map((window) => window.usedPercent)).toEqual([0, 42]);
  expect(expired.checkedAt).toBe(limits.checkedAt);
  const fresh = expireResetLimitsWindows(limits, observation.observedAtMs);
  expect(fresh.windows.map((window) => window.usedPercent)).toEqual([21, 42]);
});

it.layer(NodeServices.layer)("Muse limits bump", (it) => {
  it.effect("captures one tiny turn on a read-only host without MCP", () =>
    Effect.gen(function* () {
      const { host, seen } = makeBumpHost({ observation });
      const seenOptions: Array<MuseSdkHostOptions> = [];
      const limits = yield* runMuseLimitsBump(
        decodeSettings({}),
        {},
        "/repo",
        liveCatalog,
        async (options) => {
          seenOptions.push(options);
          return host;
        },
      );
      expect(limits?.windows.map((window) => window.usedPercent)).toEqual([21, 42]);
      expect(seenOptions.map((options) => [options.readOnly, options.sessionMcp])).toEqual([
        [true, false],
      ]);
      const start = seen.find((call) => call.method === "session/start");
      expect(start?.params).toMatchObject({ modelId: "muse-spark-1.2", providerId: "meta" });
      const turn = seen.find((call) => call.method === "turn/start");
      expect(turn?.params).toMatchObject({
        input: [{ type: "text", text: MUSE_BUMP_PROMPT }],
        reasoningEffort: "minimal",
      });
      expect(host.close).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("omits the model and effort when the catalog gave nothing to choose from", () =>
    Effect.gen(function* () {
      const { host, seen } = makeBumpHost({ observation });
      yield* runMuseLimitsBump(decodeSettings({}), {}, undefined, [], async () => host);
      const start = seen.find((call) => call.method === "session/start");
      expect(start?.params).not.toHaveProperty("modelId");
      const turn = seen.find((call) => call.method === "turn/start");
      expect(turn?.params).not.toHaveProperty("reasoningEffort");
    }),
  );

  it.effect("falls back to the notification when the final read is empty", () =>
    Effect.gen(function* () {
      const { host, seen } = makeBumpHost({ observation });
      const request = host.connection.request;
      host.connection.request = async (method: string, params?: Record<string, unknown>) => {
        if (method === "usage/read") return {};
        return request(method, params);
      };
      const limits = yield* runMuseLimitsBump(
        decodeSettings({}),
        {},
        undefined,
        [],
        async () => host,
      );
      // The final `usage/read` answered `{}`, so these bars came from the notification.
      expect(limits?.windows.map((window) => window.usedPercent)).toEqual([21, 42]);
      expect(seen.map((call) => call.method)).toContain("turn/start");
    }),
  );

  it.effect("answers undefined when the turn fails, hangs, or observes nothing", () =>
    Effect.gen(function* () {
      const failing = makeBumpHost({ observation, failTurn: true });
      expect(
        yield* runMuseLimitsBump(decodeSettings({}), {}, undefined, [], async () => failing.host),
      ).toBeUndefined();
      expect(failing.host.close).toHaveBeenCalledTimes(1);
      const hanging = makeBumpHost({ observation, hangTurn: true });
      const hung = yield* runMuseLimitsBump(
        decodeSettings({}),
        {},
        undefined,
        [],
        async () => hanging.host,
        50,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(hung)).toBeUndefined();
      expect(hanging.host.close).toHaveBeenCalledTimes(1);
      const empty = makeBumpHost({});
      expect(
        yield* runMuseLimitsBump(decodeSettings({}), {}, undefined, [], async () => empty.host),
      ).toBeUndefined();
    }),
  );

  it.effect("refreshes a stale cache through the probe and persists the observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The test clock starts at the epoch, where every fixture looks
        // fresh; move it past the stale observation instead.
        yield* TestClock.adjust(1_792_200_000_000);
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-bump-" });
        const cachePath = `${directory}/muse.json`;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const freshObservation = {
          ...observation,
          observedAtMs: nowMs,
          window: { ...observation.window, resetsAtMs: nowMs + 60_000 },
          weekly: { ...observation.weekly, resetsAtMs: nowMs + 3_600_000 },
        };
        const stale = parseMuseUsageLimits(observation)!;
        yield* writeCachedMuseUsageLimits(cachePath, stale);
        const bumpHost = makeBumpHost({ observation: freshObservation });
        let calls = 0;
        const probeHost = makeBumpHost({}).host;
        const bump = yield* makeMuseLimitsBumpController();
        const limits = yield* readMuseUsageLimits(
          decodeSettings({}),
          {},
          undefined,
          async () => (calls++ === 0 ? probeHost : bumpHost.host),
          cachePath,
          liveCatalog,
          bump,
        );
        expect(limits.windows.map((window) => window.usedPercent)).toEqual([21, 42]);
        expect(limits.unavailable).toBeUndefined();
        expect(yield* readCachedMuseUsageLimits(cachePath)).toEqual(limits);
        expect(yield* Ref.get(bump.lastSuccessMs)).toBeDefined();
      }),
    ),
  );

  it.effect("leaves a fresh cache alone and never bumps when disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.adjust(1_792_200_000_000);
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-bump-" });
        const cachePath = `${directory}/muse.json`;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const fresh = parseMuseUsageLimits({
          ...observation,
          observedAtMs: nowMs,
          window: { ...observation.window, resetsAtMs: nowMs + 3_600_000 },
          weekly: { ...observation.weekly, resetsAtMs: nowMs + 86_400_000 },
        })!;
        yield* writeCachedMuseUsageLimits(cachePath, fresh);
        let sessions = 0;
        const counting = makeBumpHost({ observation });
        const createHost = async () => {
          const host = counting.host;
          const request = host.connection.request;
          host.connection.request = async (method: string, params?: Record<string, unknown>) => {
            if (method === "session/start") sessions++;
            if (method === "usage/read") return {};
            return request(method, params);
          };
          return host;
        };
        const bump = yield* makeMuseLimitsBumpController();
        const served = yield* readMuseUsageLimits(
          decodeSettings({}),
          {},
          undefined,
          createHost,
          cachePath,
          liveCatalog,
          bump,
        );
        expect(served).toEqual(fresh);
        const disabled = yield* readMuseUsageLimits(
          decodeSettings({ limitsAutoRefresh: false }),
          {},
          undefined,
          createHost,
          `${directory}/missing.json`,
          liveCatalog,
          bump,
        );
        expect(disabled.unavailable?.reason).toBe("probeFailed");
        expect(disabled.unavailable?.message).toContain("automatic limits refresh");
        expect(sessions).toBe(0);
      }),
    ),
  );

  it.effect("cools down after a failed bump and keeps one bump in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-bump-" });
        const cachePath = `${directory}/muse.json`;
        let sessions = 0;
        const createFailingHost = async () => {
          const { host } = makeBumpHost({ observation, failTurn: true });
          const request = host.connection.request;
          host.connection.request = async (method: string, params?: Record<string, unknown>) => {
            // The probe read finds nothing (driving the bump); the bump's own turn fails.
            if (method === "usage/read") return {};
            if (method === "session/start") sessions++;
            return request(method, params);
          };
          return host;
        };
        const bump = yield* makeMuseLimitsBumpController();
        const settings = decodeSettings({});
        const first = yield* readMuseUsageLimits(
          settings,
          {},
          undefined,
          createFailingHost,
          cachePath,
          liveCatalog,
          bump,
        );
        expect(first.unavailable?.reason).toBe("probeFailed");
        expect(first.unavailable?.message).not.toContain("automatic limits refresh");
        expect(sessions).toBe(1);
        // The immediate retry cools down instead of spending another turn.
        yield* readMuseUsageLimits(
          settings,
          {},
          undefined,
          createFailingHost,
          cachePath,
          liveCatalog,
          bump,
        );
        expect(sessions).toBe(1);

        // Two probes racing share one bump turn: the second skips while
        // the first holds the permit.
        let slowSessions = 0;
        let usageReads = 0;
        const sessionStarted = yield* Deferred.make<void>();
        let releaseTurn: () => void = () => {};
        const turnGate = new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        const createSlowHost = async () => {
          const { host } = makeBumpHost({ observation, turnGate });
          const request = host.connection.request;
          host.connection.request = async (method: string, params?: Record<string, unknown>) => {
            // Both probes read before the bump's final read: the second
            // finishes while the first still waits on the turn gate.
            if (method === "usage/read") return usageReads++ < 2 ? {} : { usage: observation };
            if (method === "session/start") {
              slowSessions++;
              Deferred.doneUnsafe(sessionStarted, Effect.void);
            }
            return request(method, params);
          };
          return host;
        };
        const slowBump = yield* makeMuseLimitsBumpController();
        const slowCache = `${directory}/slow.json`;
        const racing = yield* readMuseUsageLimits(
          settings,
          {},
          undefined,
          createSlowHost,
          slowCache,
          liveCatalog,
          slowBump,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(sessionStarted);
        const second = yield* readMuseUsageLimits(
          settings,
          {},
          undefined,
          createSlowHost,
          slowCache,
          liveCatalog,
          slowBump,
        );
        releaseTurn();
        const winner = yield* Fiber.join(racing);
        expect(slowSessions).toBe(1);
        expect(winner.windows.map((window) => window.usedPercent)).toEqual([21, 42]);
        expect(second.unavailable?.reason).toBe("probeFailed");
      }),
    ),
  );
});
