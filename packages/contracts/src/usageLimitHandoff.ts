import * as Schema from "effect/Schema";

import { IsoDateTime, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

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

/** One provider instance a usage-limited thread could continue on. */
export const UsageLimitHandoffCandidate = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  /** The selection the continuation runs with: the same model when offered, else the instance default. */
  modelSelection: ModelSelection,
  modelLabel: Schema.NullOr(Schema.String),
  sameDriver: Schema.Boolean,
  sameModel: Schema.Boolean,
  usage: ProviderUsageHeadroom,
});
export type UsageLimitHandoffCandidate = typeof UsageLimitHandoffCandidate.Type;

/** Candidates for one usage-limit stop, best first. Empty when nothing else can run it. */
export const UsageLimitHandoffRecommendation = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  from: ModelSelection,
  candidates: Schema.Array(UsageLimitHandoffCandidate),
});
export type UsageLimitHandoffRecommendation = typeof UsageLimitHandoffRecommendation.Type;

export const UsageLimitHandoffRecommendInput = Schema.Struct({ threadId: ThreadId });
export type UsageLimitHandoffRecommendInput = typeof UsageLimitHandoffRecommendInput.Type;

export const UsageLimitHandoffAcceptInput = Schema.Struct({
  threadId: ThreadId,
  /** The stopped run being continued; a stale card cannot continue a later stop. */
  runId: RunId,
  /** Omit to take the top recommendation. */
  instanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitHandoffAcceptInput = typeof UsageLimitHandoffAcceptInput.Type;

export const UsageLimitHandoffAcceptResult = Schema.Struct({
  sequence: Schema.Number,
  modelSelection: ModelSelection,
});
export type UsageLimitHandoffAcceptResult = typeof UsageLimitHandoffAcceptResult.Type;

export class UsageLimitHandoffError extends Schema.TaggedError<UsageLimitHandoffError>()(
  "UsageLimitHandoffError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["not-limited", "stale-stop", "no-candidate", "dispatch-failed"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-limited":
        return "This thread is not stopped on a usage limit.";
      case "stale-stop":
        return "This thread has moved on since that usage limit.";
      case "no-candidate":
        return "No other provider can continue this thread right now.";
      case "dispatch-failed":
        return this.detail ?? "Could not continue on the other provider.";
    }
  }
}
