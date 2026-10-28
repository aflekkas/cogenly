/**
 * The machine health checks as pure functions of what MachineHealth gathered,
 * so each rule is tested without a server. Items carry statuses and fixed
 * text plus names the owner chose (machines, tasks, threads, providers),
 * never credentials, prompts, error output or file contents: reports cross
 * the peer link and feed external alerts.
 */
import type { PreviewBrowserStatus } from "../preview/PreviewBrowser.ts";
import {
  MACHINE_HEALTH_FIX_MAX_ITEMS,
  isProviderAvailable,
  type ComputerUseStatus,
  type EnvironmentId,
  type IntegrationSummary,
  type MachineHealthCheck,
  type MachineHealthCheckId,
  type MachineHealthItem,
  type MachineHealthReport,
  type MachineHealthStatus,
  type MachineInfo,
  type MachineLinkState,
  type MachineSetupStatus,
  type ProviderInstanceId,
  type ScheduledTask,
  type ServerProvider,
  type ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";

import type { SandboxStatus } from "../terminal/ReadOnlySandbox.ts";

import { formatAgo, peerReachabilityItem, peerReachabilityKey } from "./peerReachability.ts";

const GB = 1024 ** 3;

/**
 * Free space on the state volume warns only when it is small in both senses,
 * so a big disk with tens of gigabytes left stays quiet.
 */
export const DISK_WARN_FREE_BYTES = 10 * GB;
const DISK_WARN_FREE_RATIO = 0.1;
/** Under this always fails: SQLite writes start failing soon after. */
export const DISK_FAIL_FREE_BYTES = 1 * GB;
/** Under both of these also fails. */
export const DISK_FAIL_LOW_FREE_BYTES = 5 * GB;
const DISK_FAIL_FREE_RATIO = 0.03;

/** The scheduler ticks every 5 seconds; this much silence means its loop stopped. */
const SCHEDULER_WARN_AFTER_MS = 20_000;
const SCHEDULER_FAIL_AFTER_MS = 60_000;

/** A usage window this full warns before it runs out. */
const USAGE_NEAR_LIMIT_PERCENT = 90;

/** An enabled task whose next run is this far in the past is overdue. */
export const SCHEDULED_TASK_OVERDUE_GRACE_MS = 15 * 60_000;
/** Dispatching a scheduled run takes seconds; "running" this long is stuck. */
export const SCHEDULED_TASK_STUCK_AFTER_MS = 60 * 60_000;

/** A turn or subagent still running after this long is stuck, not slow. */
export const STUCK_RUN_AFTER_MS = 6 * 60 * 60_000;
/** Missing provider activity warrants attention well before the absolute run limit. */
export const RUN_INACTIVITY_AFTER_MS = 5 * 60_000;
/** Stuck runs listed per report; the summary counts them all. */
const STUCK_RUN_ITEM_LIMIT = 20;

/** Unsent local changes with no acknowledgement progress for this long are stuck. */
export const SYNC_STUCK_AFTER_MS = 5 * 60_000;

const STATUS_RANK: Record<MachineHealthStatus, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

/** Worst wins: fail > warn > unknown > ok. */
export function worstStatus(statuses: ReadonlyArray<MachineHealthStatus>): MachineHealthStatus {
  let worst: MachineHealthStatus = "ok";
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

const check = (
  id: MachineHealthCheckId,
  summary: string,
  items: ReadonlyArray<MachineHealthItem>,
): MachineHealthCheck => ({
  id,
  status: worstStatus(items.map((item) => item.status)),
  summary,
  items,
});

/** A check whose inputs could not be read. */
export const unknownCheck = (
  id: MachineHealthCheckId,
  summary = "Couldn't be checked",
): MachineHealthCheck => ({ id, status: "unknown", summary, items: [] });

const item = (input: {
  readonly key: string;
  readonly status: MachineHealthStatus;
  readonly title: string;
  readonly detail?: string;
  readonly since?: DateTime.Utc | null;
  readonly target?: MachineHealthItem["target"];
  readonly fix?: MachineHealthItem["fix"];
}): MachineHealthItem => ({
  key: input.key,
  status: input.status,
  title: input.title,
  detail: input.detail ?? "",
  since: input.since ?? null,
  target: input.target ?? null,
  fix: input.fix ?? null,
});

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  const mb = 1024 ** 2;
  if (bytes >= mb) return `${Math.round(bytes / mb)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** A name the owner chose, quoted and bounded so one long title can't flood a report. */
const quoted = (name: string) => `"${name.length > 60 ? `${name.slice(0, 59).trimEnd()}…` : name}"`;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const parseIso = (iso: string | null | undefined): DateTime.Utc | null =>
  iso == null ? null : Option.getOrNull(DateTime.make(iso).pipe(Option.map(DateTime.toUtc)));

const millisBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from);

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function buildReport(input: {
  readonly environmentId: EnvironmentId;
  readonly machineName: string;
  readonly observedAt: DateTime.Utc;
  readonly serverVersion: string;
  readonly uptimeSeconds: number;
  readonly checks: ReadonlyArray<MachineHealthCheck>;
}): MachineHealthReport {
  return {
    environmentId: input.environmentId,
    machineName: input.machineName,
    status: worstStatus(input.checks.map((entry) => entry.status)),
    observedAt: input.observedAt,
    serverVersion: input.serverVersion,
    uptimeSeconds: input.uptimeSeconds,
    reachable: true,
    checks: input.checks,
  };
}

/**
 * What a Fix without named items fixes (MCP without `itemKeys`, `cogenly health
 * --fix`): every bad item with a fix the server runs without the owner.
 * Discarding held history requires naming the item explicitly.
 */
export const directlyFixableItemKeys = (report: MachineHealthReport) =>
  report.checks
    .flatMap((entry) => entry.items)
    .filter(
      (entry) =>
        entry.status !== "ok" &&
        entry.fix !== null &&
        entry.fix !== "sign-in" &&
        entry.fix !== "discard-quarantined",
    )
    .map((entry) => entry.key)
    .slice(0, MACHINE_HEALTH_FIX_MAX_ITEMS);

/** Equal when only the observation time or uptime moved, so subscribers aren't woken for noise. */
export const sameReportContent = (left: MachineHealthReport, right: MachineHealthReport) =>
  reportContentKey(left) === reportContentKey(right);

const reportContentKey = (report: MachineHealthReport) =>
  JSON.stringify({ ...report, observedAt: null, uptimeSeconds: null }, (_key, value: unknown) =>
    DateTime.isDateTime(value) ? DateTime.toEpochMillis(value) : value,
  );

// ---------------------------------------------------------------------------
// server, database, disk
// ---------------------------------------------------------------------------

export function serverCheck(input: {
  readonly version: string;
  /** Null before the scheduler's first tick. */
  readonly schedulerHeartbeatAgeMs: number | null;
}): MachineHealthCheck {
  const age = input.schedulerHeartbeatAgeMs;
  const items: MachineHealthItem[] = [];
  if (age !== null && age >= SCHEDULER_WARN_AFTER_MS) {
    items.push(
      item({
        key: "server:scheduler",
        status: age >= SCHEDULER_FAIL_AFTER_MS ? "fail" : "warn",
        title: `The scheduler hasn't run for ${formatAgo(age)}`,
        detail:
          "Scheduled tasks, sync and housekeeping wait on it. Restarting the server restarts it.",
      }),
    );
  }
  return check("server", `Cogenly ${input.version}`, items);
}

export function databaseCheck(input: {
  readonly answered: boolean;
  readonly sizeBytes: number | null;
  readonly writerWorkerUnavailable?: boolean;
}): MachineHealthCheck {
  if (!input.answered) {
    return check("database", "The database didn't answer", [
      item({
        key: "database:query",
        status: "fail",
        title: "The database didn't answer",
        detail: "A trivial query failed or timed out. The server log has details.",
      }),
    ]);
  }
  return check(
    "database",
    input.sizeBytes === null
      ? "Database answers"
      : `Database answers (${formatBytes(input.sizeBytes)})`,
    input.writerWorkerUnavailable
      ? [
          item({
            key: "database:writer-worker",
            status: "warn",
            title: "Database writes are using the main thread",
            detail:
              "The background writer is unavailable. Writes still work, but may delay the client. Cogenly retries starting the worker on later writes.",
          }),
        ]
      : [],
  );
}

export function diskCheck(input: {
  readonly freeBytes: number;
  readonly totalBytes: number;
}): MachineHealthCheck {
  const ratio = input.totalBytes > 0 ? input.freeBytes / input.totalBytes : 1;
  const status: MachineHealthStatus =
    input.freeBytes < DISK_FAIL_FREE_BYTES ||
    (input.freeBytes < DISK_FAIL_LOW_FREE_BYTES && ratio < DISK_FAIL_FREE_RATIO)
      ? "fail"
      : input.freeBytes < DISK_WARN_FREE_BYTES && ratio < DISK_WARN_FREE_RATIO
        ? "warn"
        : "ok";
  const summary = `${formatBytes(input.freeBytes)} free of ${formatBytes(input.totalBytes)}`;
  return check(
    "disk",
    summary,
    status === "ok"
      ? []
      : [
          item({
            key: "disk:free",
            target: { _tag: "storage" },
            status,
            title:
              status === "fail"
                ? `Only ${formatBytes(input.freeBytes)} left on the disk Cogenly uses`
                : `The disk Cogenly uses is getting full (${formatBytes(input.freeBytes)} free)`,
            detail:
              "Free space on the volume holding Cogenly's data. The database stops saving work when it fills.",
          }),
        ],
  );
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

export function providersCheck(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: DateTime.Utc;
}): MachineHealthCheck {
  const enabled = input.providers.filter(
    (provider) => provider.enabled && isProviderAvailable(provider),
  );
  if (enabled.length === 0) {
    return check("providers", "No providers enabled", [
      item({
        key: "providers:none",
        status: "warn",
        title: "No provider is enabled",
        detail: "Agents and scheduled tasks can't run until Claude or Codex is enabled.",
      }),
    ]);
  }
  const items: MachineHealthItem[] = [];
  let signedIn = 0;
  for (const provider of enabled) {
    const name = provider.displayName ?? provider.instanceId;
    const target = { _tag: "provider", instanceId: provider.instanceId } as const;
    const key = `providers:${provider.instanceId}`;
    if (provider.auth.status === "authenticated") signedIn++;
    if (!provider.installed) {
      items.push(
        item({
          key: `${key}:installed`,
          status: "fail",
          title: `${name} isn't installed`,
          detail: "Install it from Settings → Providers.",
          target,
        }),
      );
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      items.push(
        item({
          key: `${key}:auth`,
          status: "fail",
          title: `${name} isn't signed in`,
          detail: "Turns on this provider fail until it is signed in again.",
          target,
          fix: "sign-in",
        }),
      );
    } else if (provider.status === "error") {
      items.push(
        item({
          key: `${key}:status`,
          status: "fail",
          title: `${name} isn't working`,
          detail: provider.message?.slice(0, 200) ?? "Its status check failed.",
          target,
        }),
      );
    }
    for (const usage of provider.usageLimits?.windows ?? []) {
      const resetsAt = parseIso(usage.resetsAt);
      // A window that has already reset is stale until the next probe.
      if (resetsAt !== null && millisBetween(input.now, resetsAt) <= 0) continue;
      if (usage.usedPercent < USAGE_NEAR_LIMIT_PERCENT) continue;
      items.push(
        item({
          key: `${key}:usage:${usage.id}`,
          status: "warn",
          title:
            usage.usedPercent >= 100
              ? `${name} has used its ${usage.label} limit`
              : `${name} is at ${Math.floor(usage.usedPercent)}% of its ${usage.label} limit`,
          detail: resetsAt === null ? "" : `It resets at ${DateTime.formatIso(resetsAt)}.`,
          target,
        }),
      );
    }
  }
  return check(
    "providers",
    `${signedIn} of ${plural(enabled.length, "provider")} signed in`,
    items,
  );
}

/** Rate-limit hits in the last hour at which an account counts as repeatedly throttled. */
export const RATE_LIMIT_REPEAT_THRESHOLD = 3;

export interface RateLimitStreak {
  readonly providerInstanceId: ProviderInstanceId;
  /** Rate-limit retry/failure items recorded in the window. */
  readonly count: number;
  readonly latestAt: DateTime.Utc;
}

/**
 * One warning per account being rate-limited over and over. The usual cause
 * is too many concurrent threads sharing one provider account, so the item
 * says so instead of just naming the symptom.
 */
export function rateLimitItems(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly streaks: ReadonlyArray<RateLimitStreak>;
}): MachineHealthItem[] {
  const items: MachineHealthItem[] = [];
  for (const streak of input.streaks) {
    if (streak.count < RATE_LIMIT_REPEAT_THRESHOLD) continue;
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === streak.providerInstanceId,
    );
    const name = provider?.displayName ?? streak.providerInstanceId;
    items.push(
      item({
        key: `providers:${streak.providerInstanceId}:rate-limited`,
        status: "warn",
        title: `${name} is being rate-limited repeatedly`,
        detail: `${streak.count} rate limits in the last hour. The likely cause is too many concurrent threads on one account; let some finish, or spread work across accounts.`,
        since: streak.latestAt,
        target: { _tag: "provider", instanceId: streak.providerInstanceId },
      }),
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// machine-links, sync
// ---------------------------------------------------------------------------

/** The machines this one has a direct link with: its hub, or its spokes. */
export const directPeers = (machines: ReadonlyArray<MachineInfo>) =>
  machines.filter((machine) => machine.relation === "hub" || machine.relation === "spoke");

/** The newest exact version known on this paired group; never recommend a downgrade. */
export const newestMachineVersion = (machines: ReadonlyArray<MachineInfo>) =>
  machines
    .filter((machine) => machine.pairing !== "revoked")
    .flatMap((machine) =>
      machine.serverVersion !== undefined && isExactServiceVersion(machine.serverVersion)
        ? [machine.serverVersion]
        : [],
    )
    .toSorted((left, right) => compareExactServiceVersions(right, left))[0];

export function machineLinksCheck(input: {
  readonly machines: ReadonlyArray<MachineInfo>;
  readonly link: MachineLinkState;
  readonly now: DateTime.Utc;
}): MachineHealthCheck {
  const peers = directPeers(input.machines);
  if (peers.length === 0) return check("machine-links", "Not paired with other machines", []);
  const items: MachineHealthItem[] = [];
  const targetVersion = newestMachineVersion(input.machines);
  if (targetVersion !== undefined) {
    for (const machine of input.machines) {
      if (
        machine.pairing === "revoked" ||
        machine.serverVersion === undefined ||
        machine.serverVersion === targetVersion
      )
        continue;
      items.push(
        item({
          key: `machine-version:${machine.environmentId}`,
          status: "warn",
          title: `Update ${machine.name} to match`,
          detail: `${machine.name} runs ${machine.serverVersion}; paired machines run ${targetVersion}.`,
          target: { _tag: "machine", environmentId: machine.environmentId },
          fix:
            machine.online &&
            machine.relation !== "peer" &&
            isExactServiceVersion(machine.serverVersion) &&
            (machine.relation === "this" ||
              compareExactServiceVersions(machine.serverVersion, "0.3.3") >= 0)
              ? "update-machine"
              : null,
        }),
      );
    }
  }
  for (const peer of peers) {
    if (
      peer.relation === "hub" &&
      input.link._tag === "spoke" &&
      input.link.status === "untrusted"
    ) {
      items.push(
        item({
          key: peerReachabilityKey(peer.environmentId),
          status: "fail",
          title: `${peer.name} couldn't prove its identity`,
          detail: "Its key doesn't match the one pinned at pairing. Unpair it and pair again.",
          target: { _tag: "machine", environmentId: peer.environmentId },
        }),
      );
      continue;
    }
    const reachability = peerReachabilityItem({
      environmentId: peer.environmentId,
      name: peer.name,
      online: peer.online,
      lastSeenAt: peer.lastSeenAt,
      pairedAt: peer.pairedAt,
      pairing: peer.pairing,
      now: input.now,
    });
    if (reachability !== null) items.push(reachability);
  }
  const online = peers.filter((peer) => peer.online).length;
  return check("machine-links", `${online} of ${plural(peers.length, "machine")} online`, items);
}

/** What one sample of the sync tables says about a direct peer. */
export interface SyncPeerSample {
  readonly quarantined?: number;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly online: boolean;
  /** Local shared-state changes and thread events the peer hasn't acknowledged. */
  readonly backlog: number;
  readonly ratePerSecond?: number;
  /** The peer's acknowledged cursors, joined; a change means sync moved. */
  readonly acknowledged: string;
  /** Changes received from the peer that this build can't read yet. */
  readonly heldChanges: number;
  /** Threads with replicated items held for a newer build. */
  readonly heldThreads: number;
}

/** Remembered between samples, so a backlog that never drains reads as stuck. */
export interface SyncPeerProgress {
  readonly acknowledged: string;
  /** When the current unmoving backlog was first seen; null when in sync or offline. */
  readonly pendingSinceMs: number | null;
  /** The last time nothing was waiting for this peer, since this server started. */
  readonly inSyncAtMs: number | null;
}

export function trackSyncProgress(
  previous: SyncPeerProgress | undefined,
  sample: SyncPeerSample,
  nowMs: number,
): SyncPeerProgress {
  if (sample.backlog === 0) {
    return { acknowledged: sample.acknowledged, pendingSinceMs: null, inSyncAtMs: nowMs };
  }
  const inSyncAtMs = previous?.inSyncAtMs ?? null;
  // An offline peer is reported by machine-links; its backlog is expected.
  if (!sample.online)
    return { acknowledged: sample.acknowledged, pendingSinceMs: null, inSyncAtMs };
  const unmoved =
    previous !== undefined &&
    previous.acknowledged === sample.acknowledged &&
    previous.pendingSinceMs !== null;
  return {
    acknowledged: sample.acknowledged,
    pendingSinceMs: unmoved ? previous.pendingSinceMs : nowMs,
    inSyncAtMs,
  };
}

/** A discard names one thread and the exact retained incoming volume. */
export const quarantinedThreadItem = (input: {
  readonly threadId: ThreadId;
  readonly title: string | null;
  readonly count: number;
  readonly bytes: number;
}): MachineHealthItem =>
  item({
    key: `sync:quarantined-thread:${input.threadId}`,
    status: "fail",
    title: `Discard quarantined changes for ${input.title ?? input.threadId}`,
    detail: `${input.count} incoming items (${input.bytes} bytes). Discard removes only these held changes; local thread data is kept. Later events can sync. Retention is capped at 1,000 items or 16 MiB per thread.`,
    target: { _tag: "thread", threadId: input.threadId },
    fix: "discard-quarantined",
  });

export function syncCheck(input: {
  readonly peers: ReadonlyArray<{
    readonly sample: SyncPeerSample;
    readonly progress: SyncPeerProgress;
  }>;
  readonly nowMs: number;
}): MachineHealthCheck {
  if (input.peers.length === 0) return check("sync", "Not paired with other machines", []);
  const items: MachineHealthItem[] = [];
  for (const { sample, progress } of input.peers) {
    const target = { _tag: "machine", environmentId: sample.environmentId } as const;
    if ((sample.quarantined ?? 0) > 0) {
      items.push(
        item({
          key: `sync:quarantined:${sample.environmentId}`,
          status: "fail",
          title: `${plural(sample.quarantined!, "change")} from ${sample.name} quarantined`,
          detail:
            "Invalid thread history could not be applied. Review the per-thread discard actions; other threads continue syncing.",
          target,
        }),
      );
    }
    if (sample.heldChanges > (sample.quarantined ?? 0)) {
      items.push(
        item({
          key: `sync:held:${sample.environmentId}`,
          status: "warn",
          title: `${plural(sample.heldChanges, "change")} from ${sample.name} wait for a Cogenly update`,
          detail:
            sample.heldThreads > 0
              ? `They touch ${plural(sample.heldThreads, "thread")}. This machine can't read them yet; they apply once Cogenly is updated here.`
              : "This machine can't read them yet; they apply once Cogenly is updated here.",
          target,
        }),
      );
    }
    if (sample.online && sample.backlog > 0) {
      const rate = sample.ratePerSecond ?? 0;
      items.push(
        item({
          key: `sync:catch-up:${sample.environmentId}`,
          status: "ok",
          title: `Catching up ${sample.name}`,
          detail: `${plural(sample.backlog, "change")} pending. ${
            rate > 0
              ? `About ${rate.toFixed(1)} changes/s; estimated ${formatAgo((sample.backlog / rate) * 1000)} remaining.`
              : "Measuring catch-up rate and time remaining."
          }`,
          target,
        }),
      );
    }
    if (
      sample.online &&
      progress.pendingSinceMs !== null &&
      input.nowMs - progress.pendingSinceMs >= SYNC_STUCK_AFTER_MS
    ) {
      items.push(
        item({
          key: `sync:stuck:${sample.environmentId}`,
          status: "fail",
          title: `Sync with ${sample.name} is stuck`,
          detail: `${plural(sample.backlog, "change")} haven't reached it for ${formatAgo(input.nowMs - progress.pendingSinceMs)}.${
            progress.inSyncAtMs === null
              ? ""
              : ` Last in sync at ${DateTime.formatIso(DateTime.makeUnsafe(progress.inSyncAtMs))}.`
          }`,
          since: DateTime.makeUnsafe(progress.pendingSinceMs),
          target,
          fix: "retry-sync",
        }),
      );
    }
  }
  const online = input.peers.filter((peer) => peer.sample.online);
  const summary =
    online.length === 0
      ? "Paired machines are offline"
      : online.every((peer) => peer.sample.backlog === 0)
        ? `In sync with ${plural(online.length, "machine")}`
        : `Syncing with ${plural(online.length, "machine")}`;
  return check("sync", summary, items);
}

// ---------------------------------------------------------------------------
// integrations
// ---------------------------------------------------------------------------

export function integrationsCheck(input: {
  readonly integrations: ReadonlyArray<IntegrationSummary>;
}): MachineHealthCheck {
  const enabled = input.integrations.filter((summary) => summary.integration.enabled);
  if (enabled.length === 0) return check("integrations", "No integrations", []);
  const items: MachineHealthItem[] = [];
  for (const summary of enabled) {
    const { integration } = summary;
    const target = { _tag: "integration", name: integration.name } as const;
    if (summary.status === "needs_sign_in") {
      items.push(
        item({
          key: `integrations:${integration.name}`,
          status: "warn",
          title: `${integration.displayName} needs sign-in`,
          detail: "Agents can't use it until it is signed in again.",
          target,
          fix: "sign-in",
        }),
      );
    } else if (summary.status === "error") {
      items.push(
        item({
          key: `integrations:${integration.name}`,
          status: "fail",
          title: `${integration.displayName} isn't working`,
          detail: "Its last connection failed. Settings → Integrations shows the error.",
          target,
        }),
      );
    }
  }
  return check("integrations", integrationsSummary(enabled.length, items), items);
}

/** The check's line in the badge's vocabulary: failing for errors, needs attention for sign-ins. */
function integrationsSummary(enabled: number, items: ReadonlyArray<MachineHealthItem>): string {
  const failing = items.filter((entry) => entry.status === "fail").length;
  const warning = items.length - failing;
  const needs = (count: number) => (count === 1 ? "needs" : "need");
  if (failing > 0 && warning > 0)
    return `${failing} failing, ${warning} ${needs(warning)} attention`;
  const of = `of ${plural(enabled, "integration")}`;
  if (failing > 0) return `${failing} ${of} ${failing === 1 ? "is" : "are"} failing`;
  if (warning > 0) return `${warning} ${of} ${needs(warning)} attention`;
  return `${plural(enabled, "integration")} working`;
}

// ---------------------------------------------------------------------------
// scheduled-tasks
// ---------------------------------------------------------------------------

/**
 * Enabled tasks this machine runs whose last run failed, whose next run is
 * well past due, or whose dispatch never finished. Tasks another machine
 * owns are that machine's report.
 */
export function scheduledTasksCheck(input: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly environmentId: EnvironmentId;
  readonly now: DateTime.Utc;
}): MachineHealthCheck {
  const own = input.tasks.filter(
    (task) =>
      task.enabled &&
      (task.ownerMachine === undefined || task.ownerMachine === input.environmentId),
  );
  if (own.length === 0) return check("scheduled-tasks", "No scheduled tasks", []);
  const items: MachineHealthItem[] = [];
  for (const task of own) {
    const key = `scheduled-tasks:${task.id}`;
    const target = { _tag: "scheduledTask", taskId: task.id } as const;
    const lastRunAt = parseIso(task.lastRunAt);
    const nextRunAt = parseIso(task.nextRunAt);
    if (
      task.lastRunStatus === "running" &&
      lastRunAt !== null &&
      millisBetween(lastRunAt, input.now) >= SCHEDULED_TASK_STUCK_AFTER_MS
    ) {
      items.push(
        item({
          key,
          status: "fail",
          title: `${quoted(task.title)} has been starting for ${formatAgo(millisBetween(lastRunAt, input.now))}`,
          detail: "Its last run never finished dispatching.",
          since: lastRunAt,
          target,
        }),
      );
    } else if (task.lastRunStatus === "failed") {
      items.push(
        item({
          key,
          status: "fail",
          title: `${quoted(task.title)} failed its last run`,
          detail:
            lastRunAt === null
              ? "Open the task to see the error."
              : `The run at ${DateTime.formatIso(lastRunAt)} failed. Open the task to see the error.`,
          since: lastRunAt,
          target,
          fix: "run-now",
        }),
      );
    } else if (
      nextRunAt !== null &&
      millisBetween(nextRunAt, input.now) >= SCHEDULED_TASK_OVERDUE_GRACE_MS
    ) {
      items.push(
        item({
          key,
          status: "fail",
          title: `${quoted(task.title)} is overdue`,
          detail: `It was due at ${DateTime.formatIso(nextRunAt)} and hasn't run.`,
          since: nextRunAt,
          target,
          fix: "run-now",
        }),
      );
    }
  }
  return check(
    "scheduled-tasks",
    items.length === 0
      ? `${plural(own.length, "scheduled task")} on track`
      : `${items.length} of ${plural(own.length, "scheduled task")} need attention`,
    items,
  );
}

// ---------------------------------------------------------------------------
// stuck-runs
// ---------------------------------------------------------------------------

export interface ActiveRun {
  readonly kind: "run" | "subagent";
  /** The run or subagent id. */
  readonly id: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly startedAt: DateTime.Utc;
  readonly inactiveSince?: DateTime.Utc;
}

export const stuckRunsItemKey = (threadId: ThreadId) => `stuck-runs:thread:${threadId}`;

/** The title for one thread's stuck turn and subagents, aged by the oldest. */
function stuckThreadTitle(threadTitle: string, runs: number, subagents: number, age: string) {
  const thread = quoted(threadTitle);
  if (subagents === 0) return `${thread} has been running for ${age}`;
  if (runs > 0) return `${thread} and ${plural(subagents, "subagent")} stuck for ${age}`;
  return subagents === 1
    ? `A subagent in ${thread} has been running for ${age}`
    : `${subagents} subagents stuck in ${thread} for ${age}`;
}

/**
 * Turns and delegated subagents on this machine still active far longer than
 * any real one runs, one item per thread: its Fix stops them all at once.
 */
export function stuckRunsCheck(input: {
  readonly active: ReadonlyArray<ActiveRun>;
  readonly now: DateTime.Utc;
}): MachineHealthCheck {
  const stuck = input.active
    .filter(
      (run) =>
        millisBetween(run.startedAt, input.now) >= STUCK_RUN_AFTER_MS ||
        (run.inactiveSince !== undefined &&
          millisBetween(run.inactiveSince, input.now) >= RUN_INACTIVITY_AFTER_MS),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt),
    );
  if (stuck.length === 0) return check("stuck-runs", "No stuck runs", []);
  // Oldest first, so each thread's first run is its oldest.
  const byThread = new Map<ThreadId, Array<ActiveRun>>();
  for (const run of stuck) byThread.set(run.threadId, [...(byThread.get(run.threadId) ?? []), run]);
  const items = [...byThread.values()].slice(0, STUCK_RUN_ITEM_LIMIT).flatMap((runs) => {
    const oldest = runs[0];
    if (oldest === undefined) return [];
    const subagents = runs.filter((run) => run.kind === "subagent").length;
    return item({
      key: stuckRunsItemKey(oldest.threadId),
      status: runs.some((run) => millisBetween(run.startedAt, input.now) >= STUCK_RUN_AFTER_MS)
        ? "fail"
        : "warn",
      title:
        oldest.inactiveSince !== undefined
          ? `${quoted(oldest.threadTitle)} has had no provider activity for ${formatAgo(millisBetween(oldest.inactiveSince, input.now))}`
          : stuckThreadTitle(
              oldest.threadTitle,
              runs.length - subagents,
              subagents,
              formatAgo(millisBetween(oldest.startedAt, input.now)),
            ),
      detail:
        oldest.inactiveSince !== undefined
          ? "The turn may be stuck starting or waiting for its provider. Open the thread to stop it and retry if needed."
          : runs.length === 1
            ? "It has likely lost its provider session. Fix stops it so the thread can continue."
            : "They have likely lost their provider sessions. Fix stops them so the thread can continue.",
      since: oldest.startedAt,
      target: { _tag: "thread", threadId: oldest.threadId },
      fix: runs.some((run) => millisBetween(run.startedAt, input.now) >= STUCK_RUN_AFTER_MS)
        ? "resume"
        : null,
    });
  });
  return check(
    "stuck-runs",
    byThread.size === 1
      ? plural(stuck.length, "stuck run")
      : `${plural(stuck.length, "stuck run")} in ${byThread.size} threads`,
    items,
  );
}

// ---------------------------------------------------------------------------
// boot-service, tailscale-serve
// ---------------------------------------------------------------------------

/**
 * Whether this server runs under the launchd/systemd service. Only an
 * always-on machine (a cloud server or a hub) is expected to: elsewhere a
 * desktop or dev run is normal.
 */
export function bootServiceCheck(input: {
  readonly managed: boolean;
  readonly alwaysOn: boolean;
}): MachineHealthCheck {
  if (input.managed) return check("boot-service", "Running as a background service", []);
  if (!input.alwaysOn) return check("boot-service", "Not running as a background service", []);
  return check("boot-service", "Not running as a background service", [
    item({
      key: "boot-service:managed",
      status: "warn",
      title: "This machine isn't running Cogenly as a background service",
      detail:
        "It won't come back after a crash or reboot. Run `cogenly service install` on this machine.",
    }),
  ]);
}

/**
 * Whether agents can drive this machine's apps. A missing macOS grant is
 * reported but never alerts: agents ask for it in the thread the first time
 * they need it, and an owner who never uses computer use should not be nagged.
 */
export function computerUseCheck(status: ComputerUseStatus): MachineHealthCheck {
  switch (status.state) {
    case "ready":
      return check("computer-use", "Agents can control this Mac's apps", []);
    case "disabled":
      return check("computer-use", "Turned off", []);
    case "unsupported":
      return check(
        "computer-use",
        status.supported ? "No desktop session to control" : "Not available on this machine",
        [],
      );
    case "needs-permission": {
      const missing = status.permissions.filter((entry) => entry.grant !== "granted");
      return check(
        "computer-use",
        `Waiting for ${missing.map((entry) => entry.title).join(" and ")}`,
        missing.map((entry) =>
          item({
            key: `computer-use:${entry.permission}`,
            status: "ok",
            title: `${entry.title} isn't granted yet`,
            detail: `Needed for ${entry.neededFor}. Agents ask the first time they need it; to grant it now, open System Settings → Privacy & Security → ${entry.title} and turn on ${status.hostApp ?? "the app that runs the Cogenly server"}.`,
          }),
        ),
      );
    }
  }
}

export function tailscaleServeCheck(input: {
  readonly serveEnabled: boolean;
  /** Read only when Serve is on. */
  readonly setup: MachineSetupStatus | null;
}): MachineHealthCheck {
  if (!input.serveEnabled || input.setup === null) {
    return check("tailscale-serve", "Tailscale Serve off", []);
  }
  const { tailscale, problem, joinUrl } = input.setup;
  // Cogenly is pointing Serve at this run (at startup, or after a port change):
  // the mapping is missing on purpose for those seconds.
  const exposing = input.setup.steps.some(
    (entry) => entry.id === "expose" && entry.state === "working",
  );
  if (!tailscale.served && exposing) {
    return check("tailscale-serve", "Pointing Tailscale Serve at this server", []);
  }
  const failure = !tailscale.installed
    ? "Tailscale isn't installed"
    : !tailscale.running
      ? "Tailscale isn't running"
      : !tailscale.signedIn
        ? "Tailscale is signed out"
        : !tailscale.served
          ? "Tailscale Serve isn't forwarding to this server"
          : null;
  if (failure !== null) {
    return check("tailscale-serve", failure, [
      item({
        key: "tailscale-serve:serving",
        status: "fail",
        title: failure,
        detail:
          problem ??
          "Paired machines can't reach this one. Settings → Machines shows the setup steps.",
      }),
    ]);
  }
  return check(
    "tailscale-serve",
    `Serving at ${joinUrl ?? tailscale.magicDnsName ?? "this machine's tailnet name"}`,
    problem === null
      ? []
      : [item({ key: "tailscale-serve:problem", status: "warn", title: problem })],
  );
}

export const AGENT_ORPHANS_ITEM_KEY = "agent-processes:orphaned";

/**
 * Commands agents started that an earlier server left running: ones marked
 * keep-running, or ones the restart could not kill. Fix kills them all.
 */
export function agentProcessesCheck(input: {
  readonly processes: ReadonlyArray<{
    readonly orphaned: boolean;
    readonly command: string;
    readonly pids: ReadonlyArray<number>;
  }>;
}): MachineHealthCheck {
  const orphans = input.processes.filter((entry) => entry.orphaned && entry.pids.length > 0);
  if (orphans.length === 0) return check("agent-processes", "No orphaned processes", []);
  const pids = orphans.reduce((total, entry) => total + entry.pids.length, 0);
  const title = `${plural(orphans.length, "orphaned agent command")} still running`;
  return check("agent-processes", title, [
    item({
      key: AGENT_ORPHANS_ITEM_KEY,
      status: "warn",
      title,
      detail: `A previous server started ${orphans
        .slice(0, 3)
        .map((entry) => quoted(entry.command.split("\n")[0] ?? ""))
        .join(
          ", ",
        )}${orphans.length > 3 ? " and more" : ""} (${pids} ${pids === 1 ? "process" : "processes"}). Nothing reads their output now. Fix kills them; Settings → Diagnostics lists each one.`,
      fix: "kill-orphans",
    }),
  ]);
}

export const chatSandboxCheck = (status: SandboxStatus): MachineHealthCheck => {
  if (status.available)
    return {
      id: "chat-terminal-sandbox",
      status: "ok",
      summary: "Chat commands are on",
      items: [],
    };
  const fixable =
    status.failure === "bwrap-missing" ||
    status.failure === "apparmor-userns" ||
    status.failure === "userns-blocked" ||
    status.failure === "probe-failed";
  const title = `Chat commands are off: ${status.reason}`;
  return {
    id: "chat-terminal-sandbox",
    status: "warn",
    summary: title,
    items: [
      {
        key: "chat-terminal-sandbox",
        status: "warn",
        title,
        detail:
          status.failure === "apparmor-userns"
            ? "bubblewrap is installed, but kernel.apparmor_restrict_unprivileged_userns=1 blocks its user namespaces. Fix installs a narrowly scoped AppArmor profile at /etc/apparmor.d/cogenly-bwrap for the bubblewrap binary only (flags=(unconfined), userns), reloads it with apparmor_parser -r, then checks the sandbox again. The global restriction stays on. If the profile already exists, Fix leaves it unchanged; if elevation is unavailable, it shows the exact commands to run."
            : fixable
              ? "Fix installs the distro bubblewrap package using root or passwordless sudo, then checks the sandbox again. If elevation is unavailable, it shows the command to run."
              : "Chat commands stay off until this host supports the required sandbox.",
        since: null,
        target: null,
        fix: fixable ? "setup-sandbox" : null,
      },
    ],
  };
};

/** Queue stalls share the run-health section and link directly to their thread. */
export function stuckQueuesItems(queues: ReadonlyArray<ActiveRun>): MachineHealthItem[] {
  return queues.map((queue) => ({
    key: `stuck-queue:thread:${queue.threadId}`,
    status: "warn",
    title: `Queued messages not sending in ${queue.threadTitle}`,
    detail: "The provider turn is idle. Fix sends the next queued message now.",
    since: queue.startedAt,
    target: { _tag: "thread", threadId: queue.threadId },
    fix: "send-queue",
  }));
}

/** Installation is per Cogenly home, independent of Playwright's browser cache. */
export function previewBrowserCheck(
  input: PreviewBrowserStatus & {
    readonly hostProblem?: string;
  },
): MachineHealthCheck {
  if (input.state === "ready" && input.hostProblem === undefined)
    return check("preview-browser", "The preview browser is ready", []);
  const host = input.hostProblem !== undefined;
  const title = host
    ? "The preview browser needs host setup"
    : input.state === "installing"
      ? "Installing the preview browser"
      : input.state === "missing"
        ? "The preview browser is not installed yet"
        : "The preview browser needs attention";
  return check("preview-browser", title, [
    item({
      key: host ? "preview-browser:host" : "preview-browser:install",
      status: input.state === "missing" || input.state === "installing" ? "warn" : "fail",
      title,
      detail: input.hostProblem ?? input.detail,
      fix: input.state === "unsupported" ? null : "setup-browser",
    }),
  ]);
}
