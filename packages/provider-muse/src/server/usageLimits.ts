import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MuseSettings } from "../settings.ts";
import { createMuseSdkHost, createMuseSdkHostEffect } from "./sdk.ts";

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
