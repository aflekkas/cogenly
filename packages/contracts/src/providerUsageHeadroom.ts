import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

/**
 * How much of a provider instance's subscription is left, as far as this
 * environment knows. `unknown` covers API keys, failed probes, and drivers
 * without usage reporting. `stale` marks a reading too old to trust blindly.
 */
export const ProviderUsageHeadroom = Schema.Struct({
  state: Schema.Literals(["available", "exhausted", "unknown"]),
  /** The tightest window's remaining percent, or null when no window is known. */
  remainingPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(IsoDateTime),
  stale: Schema.Boolean,
  windows: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      kind: ServerProviderUsageWindow.fields.kind,
      usedPercent: Schema.Number,
      resetsAt: Schema.optional(IsoDateTime),
    }),
  ),
});
export type ProviderUsageHeadroom = typeof ProviderUsageHeadroom.Type;
