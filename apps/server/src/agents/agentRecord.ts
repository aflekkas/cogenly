import { Agent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decode = Schema.decodeUnknownEffect(Agent);

/** Runtime columns override the saved configuration, including automatic failure pauses. */
export const decodeAgentRow = (row: {
  readonly payload_json: string;
  readonly enabled: number;
  readonly consecutive_failures: number;
  readonly backoff_until: string | null;
  readonly pause_reason: string | null;
  readonly daily_run_cap: number;
}): Effect.Effect<Agent, Schema.SchemaError> =>
  Effect.gen(function* () {
    const data = yield* decodePayload(row.payload_json);
    return yield* decode({
      // The idempotent legacy importer can run after the policy migration.
      responsibility: "",
      scope: [],
      autonomy: "autonomous_within_policy",
      permissions: {
        read: true,
        draft: true,
        execute: true,
        send: true,
        create_pr: true,
        merge: true,
        deploy: true,
        delete: true,
      },
      notifyPolicy: "all",
      ...data,
      paused: row.enabled !== 1,
      enabled: row.enabled === 1,
      consecutiveFailures: row.consecutive_failures,
      backoffUntil: row.backoff_until,
      pauseReason: row.pause_reason,
      dailyRunCap: row.daily_run_cap,
    });
  });
