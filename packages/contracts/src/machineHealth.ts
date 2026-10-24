import * as Schema from "effect/Schema";

import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId, ScheduledTaskId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Health of one Cogenly server: each subsystem an always-on machine depends
 * on, so the owner learns about breakage without checking by hand. Reports
 * carry statuses and short human text, never credentials, tokens, prompts or
 * file contents: they cross the peer link and feed external alerts.
 * See apps/server/src/health/MachineHealth.ts.
 */

/** Worst wins: fail > warn > unknown > ok. `unknown` means the check could not run. */
export const MachineHealthStatus = Schema.Literals(["ok", "warn", "fail", "unknown"]);
export type MachineHealthStatus = typeof MachineHealthStatus.Type;

export const MachineHealthCheckId = Schema.Literals([
  "server",
  "database",
  "disk",
  "providers",
  "machine-links",
  "sync",
  "integrations",
  "scheduled-tasks",
  "stuck-runs",
  "boot-service",
  "tailscale-serve",
  "canary",
]);
export type MachineHealthCheckId = typeof MachineHealthCheckId.Type;

/** The failing thing an item points at, so clients can link to it. */
export const MachineHealthTarget = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("scheduledTask", { taskId: ScheduledTaskId }),
  Schema.TaggedStruct("provider", { instanceId: ProviderInstanceId }),
  Schema.TaggedStruct("integration", { name: TrimmedNonEmptyString }),
  Schema.TaggedStruct("machine", { environmentId: EnvironmentId }),
]);
export type MachineHealthTarget = typeof MachineHealthTarget.Type;

/**
 * A one-click remedy. Clients map each kind to an existing command or screen:
 * `sign-in` opens the provider or integration sign-in, `run-now` runs the
 * scheduled task, `resume` opens the stuck thread, `retry-sync` calls
 * `machines.healthRetrySync`.
 */
export const MachineHealthFix = Schema.Literals(["sign-in", "run-now", "resume", "retry-sync"]);
export type MachineHealthFix = typeof MachineHealthFix.Type;

export const MachineHealthItem = Schema.Struct({
  /** Stable across reports, e.g. `providers:claude`; alert state is keyed on it. */
  key: TrimmedNonEmptyString,
  status: MachineHealthStatus,
  title: TrimmedNonEmptyString,
  detail: Schema.String,
  /** When this item entered its current status, when known. */
  since: Schema.NullOr(Schema.DateTimeUtc),
  target: Schema.NullOr(MachineHealthTarget),
  fix: Schema.NullOr(MachineHealthFix),
});
export type MachineHealthItem = typeof MachineHealthItem.Type;

export const MachineHealthCheck = Schema.Struct({
  id: MachineHealthCheckId,
  status: MachineHealthStatus,
  /** One line, e.g. "2 of 3 providers signed in". */
  summary: Schema.String,
  /** Only the entries worth showing: problems, plus one ok line where useful. */
  items: Schema.Array(MachineHealthItem),
});
export type MachineHealthCheck = typeof MachineHealthCheck.Type;

export const MachineHealthReport = Schema.Struct({
  environmentId: EnvironmentId,
  machineName: TrimmedNonEmptyString,
  status: MachineHealthStatus,
  observedAt: Schema.DateTimeUtc,
  serverVersion: TrimmedNonEmptyString,
  uptimeSeconds: Schema.Number,
  /**
   * False when this report was not read from the machine itself: it is
   * offline or unreachable, and the report was built from what its peer saw.
   */
  reachable: Schema.Boolean,
  checks: Schema.Array(MachineHealthCheck),
});
export type MachineHealthReport = typeof MachineHealthReport.Type;

export const MachineHealthInput = Schema.Struct({
  /** Omit for this machine. Any paired machine is read over the peer link. */
  environmentId: Schema.optionalKey(EnvironmentId),
});
export type MachineHealthInput = typeof MachineHealthInput.Type;

export const MachineHealthRetrySyncInput = Schema.Struct({ environmentId: EnvironmentId });
export type MachineHealthRetrySyncInput = typeof MachineHealthRetrySyncInput.Type;

const ChannelTestOutcome = Schema.Struct({
  /** False when the channel is off or not configured; nothing was sent. */
  attempted: Schema.Boolean,
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const MachineHealthChannelTestResult = Schema.Struct({
  slack: ChannelTestOutcome,
  email: ChannelTestOutcome,
});
export type MachineHealthChannelTestResult = typeof MachineHealthChannelTestResult.Type;

export class MachineHealthError extends Schema.TaggedError<MachineHealthError>()(
  "MachineHealthError",
  {
    reason: Schema.Literals(["not-paired", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not-paired"
      ? "That machine is not paired with this one."
      : "Machine health could not be read.";
  }
}

// ---------------------------------------------------------------------------
// Alerts: transitions of health items, debounced on the server.
// ---------------------------------------------------------------------------

export const MachineHealthAlert = Schema.Struct({
  /**
   * Unique per transition: `<originEnvironmentId>:<itemKey>:<openedAtMs>`.
   * A client connected to several machines may receive the same alert from
   * each; it shows it once by id.
   */
  id: TrimmedNonEmptyString,
  /** The machine the problem is on (for "hub unreachable", the hub). */
  originEnvironmentId: EnvironmentId,
  originMachineName: TrimmedNonEmptyString,
  itemKey: TrimmedNonEmptyString,
  checkId: MachineHealthCheckId,
  /** `open` while bad; `resolved` once the item recovers. */
  state: Schema.Literals(["open", "resolved"]),
  status: MachineHealthStatus,
  /** E.g. "Contabo VPS hasn't been reachable for 10 minutes". */
  title: TrimmedNonEmptyString,
  detail: Schema.String,
  openedAt: Schema.DateTimeUtc,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
  target: Schema.NullOr(MachineHealthTarget),
  fix: Schema.NullOr(MachineHealthFix),
});
export type MachineHealthAlert = typeof MachineHealthAlert.Type;

/** Every open alert, then again after each transition. */
export const MachineHealthAlertsSnapshot = Schema.Struct({
  open: Schema.Array(MachineHealthAlert),
  /** Alerts resolved recently, newest first, so clients can retract a toast. */
  recentlyResolved: Schema.Array(MachineHealthAlert),
});
export type MachineHealthAlertsSnapshot = typeof MachineHealthAlertsSnapshot.Type;

// ---------------------------------------------------------------------------
// Peer channels: one paired machine reading the other's health.
// ---------------------------------------------------------------------------

export const MachineHealthRead = makePeerChannel({
  name: "health.report.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({}),
  success: MachineHealthReport,
  error: MachineHealthError,
});

/** The other machine's own alerts, never ones it relays, so they cannot loop. */
export const MachineHealthAlertsRead = makePeerChannel({
  name: "health.alerts.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({}),
  success: MachineHealthAlertsSnapshot,
  error: MachineHealthError,
});
