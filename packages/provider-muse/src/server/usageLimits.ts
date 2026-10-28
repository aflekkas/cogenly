import {
  ServerProvider,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { MuseSettings } from "../settings.ts";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHost } from "./sdk.ts";

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
const decodeUsageResponseOption = Schema.decodeUnknownOption(
  Schema.Struct({ usage: Schema.optional(Schema.Unknown) }),
);
const decodeUsage = Schema.decodeUnknownOption(MuseSubscriptionUsage);
const decodeCachedProvider = Schema.decodeUnknownOption(Schema.fromJsonString(ServerProvider));

/** Parse a raw `usage/read` result (`{ usage?: SubscriptionUsage }`). */
export function parseMuseUsageReadResponse(value: unknown): ServerProviderUsageLimits | undefined {
  const response = decodeUsageResponseOption(value);
  return response._tag === "Some" ? parseMuseUsageLimits(response.value.usage) : undefined;
}

/**
 * Read limits from a host that has already made a model call (a chat or
 * text-generation turn). A fresh host has observed nothing and answers `{}`.
 */
export const readMuseUsageLimitsFromHost = Effect.fn("readMuseUsageLimitsFromHost")(function* (
  host: MuseSdkHost,
) {
  const result = yield* Effect.tryPromise(() => host.connection.request("usage/read", {})).pipe(
    Effect.timeoutOption(2_000),
    Effect.orElseSucceed(() => undefined),
  );
  return result === undefined || result._tag === "None"
    ? undefined
    : parseMuseUsageReadResponse(result.value);
});

/**
 * Last-known limits from the server's persisted provider snapshot
 * (`<providerStatusCacheDir>/<instanceId>.json`). Muse only observes usage
 * on hosts that made a model call, so after a restart nothing can report
 * until the next turn; the cached windows bridge that gap. Windows whose
 * reset has passed are dropped — their successor window is unobserved.
 */
export const readCachedMuseUsageLimits = Effect.fn("readCachedMuseUsageLimits")(function* (
  cacheDir: string,
  instanceId: ProviderInstanceId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(cacheDir, `${instanceId}.json`))
    .pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return undefined;
  const cached = decodeCachedProvider(raw);
  if (cached._tag === "None") return undefined;
  const provider = cached.value;
  if (provider.driver !== "muse" || provider.instanceId !== instanceId) return undefined;
  const limits = provider.usageLimits;
  if (!limits || limits.windows.length === 0) return undefined;
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const windows = limits.windows.filter(
    (window) => window.resetsAt === undefined || window.resetsAt > nowIso,
  );
  return windows.length > 0 ? { ...limits, windows } : undefined;
});

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
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const usage = yield* Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      createMuseSdkHostEffect(
        { binaryPath: settings.binaryPath, environment, ...(cwd ? { cwd } : {}), readOnly: true },
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
  // An empty host has no observation until Muse receives provider headers. Keep
  // this recoverable so a later usage/changed notification can publish real bars.
  return (
    usage ??
    ({
      checkedAt,
      windows: [],
      unavailable: {
        reason: "probeFailed",
        message:
          "Limits not reported by Muse. Usage will appear when Muse reports a subscription observation.",
      },
    } satisfies ServerProviderUsageLimits)
  );
});
