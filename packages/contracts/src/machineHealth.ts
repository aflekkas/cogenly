import * as Schema from "effect/Schema";

import {
  AuthEnvironmentMaintainScope,
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthPeerDelegateScope,
  AuthSyncReplicateScope,
} from "./auth.ts";
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
  "computer-use",
  "chat-terminal-sandbox",
  "agent-processes",
  "preview-browser",
]);
export type MachineHealthCheckId = typeof MachineHealthCheckId.Type;

/** The failing thing an item points at, so clients can link to it. */
export const MachineHealthTarget = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  Schema.TaggedStruct("scheduledTask", { taskId: ScheduledTaskId }),
  Schema.TaggedStruct("provider", { instanceId: ProviderInstanceId }),
  Schema.TaggedStruct("integration", { name: TrimmedNonEmptyString }),
  Schema.TaggedStruct("machine", { environmentId: EnvironmentId }),
  Schema.TaggedStruct("storage", {}),
]);
export type MachineHealthTarget = typeof MachineHealthTarget.Type;

/**
 * A direct remedy, run by `machines.healthFix` on the machine the item is on:
 * `run-now` runs the scheduled task, `stop-runs` stops the thread's stale runs
 * and subagents, `retry-sync` retries sync with the target machine,
 * `setup-sandbox` installs the chat sandbox, `kill-orphans` kills commands an
 * earlier server left running. `sign-in` needs the owner, so
 * clients open the provider or integration sign-in instead. Stuck-run reports
 * emit `resume` for 0.3.1 wire compatibility; 0.3.2 handles it as `stop-runs`.
 * An item without a fix gets an agent: clients start a chat to investigate it.
 */
export const MachineHealthFix = Schema.Literals([
  "sign-in",
  "run-now",
  "resume",
  "stop-runs",
  "send-queue",
  "retry-sync",
  "discard-quarantined",
  "setup-sandbox",
  "setup-browser",
  "update-machine",
  "kill-orphans",
]);
export type MachineHealthFix = typeof MachineHealthFix.Type;

/**
 * The scope each fix actually needs, checked per selected item before the
 * fix runs locally or is forwarded to a peer. `machinesHealthFix` itself is
 * gated on `orchestration:operate`, which must not silently grant updating
 * Cogenly, installing the sandbox, or killing processes.
 */
export const MACHINE_HEALTH_FIX_REQUIRED_SCOPES: Record<MachineHealthFix, AuthEnvironmentScope> = {
  "sign-in": AuthOrchestrationOperateScope,
  "run-now": AuthOrchestrationOperateScope,
  resume: AuthOrchestrationOperateScope,
  "stop-runs": AuthOrchestrationOperateScope,
  "send-queue": AuthOrchestrationOperateScope,
  "retry-sync": AuthOrchestrationOperateScope,
  "discard-quarantined": AuthOrchestrationOperateScope,
  "setup-sandbox": AuthEnvironmentMaintainScope,
  "setup-browser": AuthEnvironmentMaintainScope,
  "update-machine": AuthEnvironmentMaintainScope,
  // Killing processes is the same capability as serverKillAgentProcess.
  "kill-orphans": AuthEnvironmentMaintainScope,
};
export const requiredScopeForMachineHealthFix = (
  fix: MachineHealthFix | null,
): AuthEnvironmentScope =>
  fix === null ? AuthOrchestrationOperateScope : MACHINE_HEALTH_FIX_REQUIRED_SCOPES[fix];

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

/** At most this many items per Fix: a grouped alert sends every item it collapsed. */
export const MACHINE_HEALTH_FIX_MAX_ITEMS = 100;

const MachineHealthFixItemKeys = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MACHINE_HEALTH_FIX_MAX_ITEMS),
);

/**
 * What to do with the items. `fix` (the default) runs each item's own fix.
 * `turn-off-provider` is the other way out of a `sign-in` item for a provider:
 * it turns that provider off in the item machine's own settings, so the
 * provider stays on for every other machine. It needs `providers:manage`.
 */
export const MachineHealthFixAction = Schema.Literals(["fix", "turn-off-provider"]);
export type MachineHealthFixAction = typeof MachineHealthFixAction.Type;

export const MachineHealthFixInput = Schema.Struct({
  /** The machine the items are on. Omit for this machine; a paired one runs it over the peer link. */
  environmentId: Schema.optionalKey(EnvironmentId),
  itemKeys: MachineHealthFixItemKeys,
  action: Schema.optionalKey(MachineHealthFixAction),
});
export type MachineHealthFixInput = typeof MachineHealthFixInput.Type;

/**
 * What Fix did with one item. `fixed`: the remedy ran. `failed`: it ran and
 * didn't fix it. `resolved`: the item was already gone. `manual`: no direct
 * fix, so an agent or the owner has to look (the message says where).
 */
export const MachineHealthFixOutcome = Schema.Struct({
  itemKey: TrimmedNonEmptyString,
  status: Schema.Literals(["fixed", "failed", "resolved", "manual"]),
  message: Schema.String,
});
export type MachineHealthFixOutcome = typeof MachineHealthFixOutcome.Type;

export const MachineHealthFixResult = Schema.Struct({
  environmentId: EnvironmentId,
  machineName: TrimmedNonEmptyString,
  /** One or two sentences for a toast or an agent. */
  summary: Schema.String,
  outcomes: Schema.Array(MachineHealthFixOutcome),
});
export type MachineHealthFixResult = typeof MachineHealthFixResult.Type;

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

/** Runs Fix on the machine the items are on, from a paired machine. */
export const MachineHealthFixRun = makePeerChannel({
  name: "health.fix.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({
    itemKeys: MachineHealthFixItemKeys,
    /** The original caller's scopes, forwarded so the peer checks them, not its peer credential. */
    callerScopes: Schema.optionalKey(Schema.Array(AuthEnvironmentScope)),
  }),
  success: MachineHealthFixResult,
  error: MachineHealthError,
});

/**
 * Turns off the providers of `sign-in` items on the machine they are on, from
 * a paired machine. Its own channel, so a peer from before it fails instead of
 * running the items' sign-in fix.
 */
export const MachineHealthTurnOffProviderRun = makePeerChannel({
  name: "health.turn-off-provider.v1",
  scope: AuthPeerDelegateScope,
  payload: MachineHealthFixRun.payload,
  success: MachineHealthFixResult,
  error: MachineHealthError,
});

/** Update this peer to a version already running on a paired machine. */
export const MachineVersionUpdate = makePeerChannel({
  name: "health.update-version.v1",
  scope: AuthPeerDelegateScope,
  payload: Schema.Struct({ targetVersion: TrimmedNonEmptyString }),
  success: Schema.Struct({}),
  error: MachineHealthError,
});

/** Older peers must reject automatic updates rather than restart without an idle check. */
export const MachineVersionAutoUpdate = makePeerChannel({
  name: "health.auto-update-version.v1",
  scope: AuthPeerDelegateScope,
  payload: MachineVersionUpdate.payload,
  success: Schema.Struct({ started: Schema.Boolean }),
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
