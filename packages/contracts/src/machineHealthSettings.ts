import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The `health` block of ServerSettings, per machine. Kept apart from
 * machineHealth.ts so settings.ts does not import the peer protocol.
 */

export const MACHINE_HEALTH_CANARY_MIN_INTERVAL_MINUTES = 15;
export const MACHINE_HEALTH_CANARY_MAX_INTERVAL_MINUTES = 24 * 60;

const CanaryIntervalMinutes = Schema.Int.check(
  Schema.isBetween({
    minimum: MACHINE_HEALTH_CANARY_MIN_INTERVAL_MINUTES,
    maximum: MACHINE_HEALTH_CANARY_MAX_INTERVAL_MINUTES,
  }),
);

export const MachineHealthCanarySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  intervalMinutes: CanaryIntervalMinutes.pipe(Schema.withDecodingDefault(Effect.succeed(60))),
});
export type MachineHealthCanarySettings = typeof MachineHealthCanarySettings.Type;

/** External alert channels, off by default; delivered through Cogenly integrations. */
export const MachineHealthAlertChannels = Schema.Struct({
  slack: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    /** The connected Slack integration's name. */
    integration: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    /** Slack member ID to DM, e.g. U012ABCDEF. */
    userId: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  email: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    /** The connected Google Workspace integration's name. */
    integration: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    to: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type MachineHealthAlertChannels = typeof MachineHealthAlertChannels.Type;

export const MachineHealthSettings = Schema.Struct({
  canary: MachineHealthCanarySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  alertChannels: MachineHealthAlertChannels.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Retry sync and stop stale runs that lost their provider sessions
   * without asking; alerts only when one fails. Machine updates stay manual.
   */
  autoFix: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type MachineHealthSettings = typeof MachineHealthSettings.Type;

export const MachineHealthSettingsPatch = Schema.Struct({
  autoFix: Schema.optionalKey(Schema.Boolean),
  canary: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      intervalMinutes: Schema.optionalKey(CanaryIntervalMinutes),
    }),
  ),
  alertChannels: Schema.optionalKey(
    Schema.Struct({
      slack: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          integration: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
          userId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
        }),
      ),
      email: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          integration: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
          to: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
        }),
      ),
    }),
  ),
});
export type MachineHealthSettingsPatch = typeof MachineHealthSettingsPatch.Type;
