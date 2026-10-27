import * as Schema from "effect/Schema";

/** Budgets cover acknowledgement separately from the first visible result. */
export const ACTION_LATENCY_BUDGETS = {
  "message.send": 300,
  "message.queue": 300,
  "message.ack": 150,
  "turn.stop": 500,
  "thread.open": 300,
  "project.switch": 300,
  "settings.open": 300,
  "settings.load": 300,
  "provider.signIn": 1_000,
  "rpc.remote": 500,
  "threads.load": 500,
  "app.startup": 2_000,
} as const;

export type LatencyAction = keyof typeof ACTION_LATENCY_BUDGETS;

export const ActionLatencySummary = Schema.Struct({
  action: Schema.String,
  phase: Schema.Literals(["visible", "ack", "server"]),
  count: Schema.Number,
  failureCount: Schema.Number,
  p50Ms: Schema.NullOr(Schema.Number),
  p95Ms: Schema.NullOr(Schema.Number),
  maxMs: Schema.NullOr(Schema.Number),
  budgetMs: Schema.Number,
  breachCount: Schema.Number,
  status: Schema.Literals(["unmeasured", "ok", "breach"]),
  truncated: Schema.Boolean,
  traceId: Schema.NullOr(Schema.String),
  spanId: Schema.NullOr(Schema.String),
});

export const ActionLatencyReport = Schema.Struct({
  windowMs: Schema.Number,
  sinceEpochMs: Schema.Number,
  untilEpochMs: Schema.Number,
  actions: Schema.Array(ActionLatencySummary),
  spans: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      count: Schema.Number,
      p50Ms: Schema.Number,
      p95Ms: Schema.Number,
      maxMs: Schema.Number,
      traceId: Schema.String,
      spanId: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
});
export type ActionLatencyReport = typeof ActionLatencyReport.Type;
