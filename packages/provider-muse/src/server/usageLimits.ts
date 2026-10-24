import type { ServerProviderModel, ServerProviderUsageLimits } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { MuseSettings } from "../settings.ts";
import {
  expireResetLimitsWindows,
  extractBumpObservation,
  MUSE_BUMP_ATTEMPT_COOLDOWN_MS,
  museBumpMinIntervalMs,
  runMuseLimitsBump,
  shouldBumpMuseLimits,
  type MuseLimitsBumpController,
} from "./limitsBump.ts";
import { createMuseSdkHost, createMuseSdkHostEffect } from "./sdk.ts";
import { readCachedMuseUsageLimits, writeCachedMuseUsageLimits } from "./usageLimitsCache.ts";

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
const UsageWindow = Schema.Struct({
  usedPercent: NonNegative,
  resetsAtMs: Timestamp,
});
export const MuseSubscriptionUsage = Schema.Struct({
  observedAtMs: Timestamp,
  tier: Schema.String,
  window: Schema.Struct({
    ...UsageWindow.fields,
    windowDurationMins: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  weekly: UsageWindow,
});
const decodeUsageResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ usage: Schema.optional(Schema.Unknown) }),
);
const decodeUsage = Schema.decodeUnknownOption(MuseSubscriptionUsage);

/** MSP usage/read and usage/changed share this account-level payload (not context occupancy). */
export function parseMuseUsageLimits(value: unknown): ServerProviderUsageLimits | undefined {
  const decoded = decodeUsage(value);
  if (decoded._tag === "None") return undefined;
  const usage = decoded.value;
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
    windows: [
      {
        id: "window",
        kind: "session",
        label: "Session",
        // Muse permits over-quota values; the shared bar contract is bounded at 100.
        usedPercent: Math.min(100, usage.window.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.window.resetsAtMs)),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: Math.min(100, usage.weekly.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.weekly.resetsAtMs)),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  };
}

export const readMuseUsageLimits = Effect.fn("readMuseUsageLimits")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
  usageLimitsCachePath: string | undefined = undefined,
  models: ReadonlyArray<ServerProviderModel> = [],
  bump: MuseLimitsBumpController | undefined = undefined,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const usage = yield* Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      createMuseSdkHostEffect(
        {
          binaryPath: settings.binaryPath,
          environment,
          ...(cwd ? { cwd } : {}),
          readOnly: true,
          // The probe only reads usage; it never attaches an MCP server.
          sessionMcp: false,
        },
        createHost,
      ),
      (host) => Effect.promise(() => host.close()),
      { interruptible: true },
    );
    const result = yield* Effect.tryPromise(() => host.connection.request("usage/read", {}));
    const response = yield* decodeUsageResponse(result);
    return parseMuseUsageLimits(response.usage);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(8_000),
    Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
  if (usage !== undefined) return usage;
  // A fresh host has no observation until it receives provider headers, so
  // `usage/read` answers `{}` here even for a subscribed account. Serve the
  // last observation a live session cached; its checkedAt stays the
  // observation time, marking how stale the bars are.
  const cached =
    usageLimitsCachePath === undefined
      ? undefined
      : yield* readCachedMuseUsageLimits(usageLimitsCachePath).pipe(
          Effect.orElseSucceed(() => undefined),
        );
  if (bump !== undefined) {
    const bumped = yield* maybeBumpMuseLimits({
      settings,
      environment,
      cwd,
      createHost,
      usageLimitsCachePath,
      models,
      bump,
      cached,
    });
    if (bumped !== undefined) return bumped;
  }
  if (cached !== undefined) {
    return expireResetLimitsWindows(cached, DateTime.toEpochMillis(yield* DateTime.now));
  }
  return {
    checkedAt,
    windows: [],
    unavailable: {
      reason: "probeFailed",
      message: settings.limitsAutoRefresh
        ? "Muse hasn't reported limits yet. They'll show up after your next Muse Code message."
        : "Muse hasn't reported limits yet. They'll show up after your next Muse Code message, or turn on automatic limits refresh in the Muse Code provider settings.",
    },
  } satisfies ServerProviderUsageLimits;
});

/**
 * Spend one bump turn when the observation is missing or stale, persist it
 * beside the live-turn cache, and hand it to the probe. Skips when another
 * bump is in flight; any failure answers undefined so the probe serves the
 * cache or the banner instead.
 */
const maybeBumpMuseLimits = Effect.fn("maybeBumpMuseLimits")(function* (input: {
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly createHost: typeof createMuseSdkHost;
  readonly usageLimitsCachePath: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly bump: MuseLimitsBumpController;
  readonly cached: ServerProviderUsageLimits | undefined;
}) {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const [lastAttemptMs, lastSuccessMs] = yield* Effect.all([
    Ref.get(input.bump.lastAttemptMs),
    Ref.get(input.bump.lastSuccessMs),
  ]);
  if (
    !shouldBumpMuseLimits({
      nowMs,
      autoRefresh: input.settings.limitsAutoRefresh,
      minIntervalMs: museBumpMinIntervalMs(input.settings.limitsMinInterval),
      attemptCooldownMs: MUSE_BUMP_ATTEMPT_COOLDOWN_MS,
      observation: extractBumpObservation(input.cached),
      lastAttemptMs,
      lastSuccessMs,
    })
  ) {
    return undefined;
  }
  if (!(yield* Semaphore.takeIfAvailable(input.bump.semaphore, 1))) return undefined;
  return yield* Effect.gen(function* () {
    yield* Ref.set(input.bump.lastAttemptMs, nowMs);
    const limits = yield* runMuseLimitsBump(
      input.settings,
      input.environment,
      input.cwd,
      input.models,
      input.createHost,
    );
    if (limits === undefined) return undefined;
    yield* Ref.set(input.bump.lastSuccessMs, nowMs);
    if (input.usageLimitsCachePath !== undefined) {
      yield* writeCachedMuseUsageLimits(input.usageLimitsCachePath, limits).pipe(
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );
    }
    return limits;
  }).pipe(Effect.ensuring(Semaphore.release(input.bump.semaphore, 1)));
});
