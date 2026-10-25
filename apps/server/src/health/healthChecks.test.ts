import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  IntegrationId,
  type IntegrationSummary,
  type MachineHealthCheck,
  type MachineInfo,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import {
  DISK_FAIL_FREE_BYTES,
  DISK_WARN_FREE_BYTES,
  SCHEDULED_TASK_OVERDUE_GRACE_MS,
  SCHEDULED_TASK_STUCK_AFTER_MS,
  STUCK_RUN_AFTER_MS,
  SYNC_STUCK_AFTER_MS,
  type SyncPeerSample,
  buildReport,
  diskCheck,
  integrationsCheck,
  machineLinksCheck,
  providersCheck,
  sameReportContent,
  scheduledTasksCheck,
  serverCheck,
  stuckRunsCheck,
  syncCheck,
  trackSyncProgress,
  worstStatus,
} from "./healthChecks.ts";
import {
  PEER_OFFLINE_FAIL_AFTER,
  peerReachabilityItem,
  unreachableReport,
} from "./peerReachability.ts";

const NOW_MS = Date.parse("2026-10-24T12:00:00.000Z");
const now = DateTime.makeUnsafe(NOW_MS);
const ago = (ms: number) => DateTime.makeUnsafe(NOW_MS - ms);
const iso = (ms: number) => DateTime.formatIso(ago(ms));
const minutes = (count: number) => count * 60_000;
const GB = 1024 ** 3;

const self = EnvironmentId.make("env-self");
const vps = EnvironmentId.make("env-vps");

const statusOf = (check: MachineHealthCheck) => check.status;

describe("worstStatus", () => {
  it("ranks fail over warn over unknown over ok", () => {
    assert.strictEqual(worstStatus([]), "ok");
    assert.strictEqual(worstStatus(["ok", "unknown"]), "unknown");
    assert.strictEqual(worstStatus(["unknown", "warn", "ok"]), "warn");
    assert.strictEqual(worstStatus(["warn", "fail", "unknown"]), "fail");
  });

  it("gives the report its worst check's status", () => {
    const report = buildReport({
      environmentId: self,
      machineName: "Laptop",
      observedAt: now,
      serverVersion: "1.0.0",
      uptimeSeconds: 10,
      checks: [
        serverCheck({ version: "1.0.0", schedulerHeartbeatAgeMs: 1_000 }),
        { id: "canary", status: "unknown", summary: "Couldn't be checked", items: [] },
        diskCheck({ freeBytes: 4 * GB, totalBytes: 100 * GB }),
      ],
    });
    assert.strictEqual(report.status, "warn");
    assert.isTrue(report.reachable);
  });

  it("treats reports that differ only in time and uptime as the same content", () => {
    const base = {
      environmentId: self,
      machineName: "Laptop",
      serverVersion: "1.0.0",
      checks: [serverCheck({ version: "1.0.0", schedulerHeartbeatAgeMs: null })],
    };
    const first = buildReport({ ...base, observedAt: now, uptimeSeconds: 10 });
    const later = buildReport({ ...base, observedAt: ago(-30_000), uptimeSeconds: 40 });
    assert.isTrue(sameReportContent(first, later));
    const changed = buildReport({
      ...base,
      observedAt: now,
      uptimeSeconds: 10,
      checks: [serverCheck({ version: "1.0.0", schedulerHeartbeatAgeMs: 90_000 })],
    });
    assert.isFalse(sameReportContent(first, changed));
  });
});

describe("serverCheck", () => {
  it("warns, then fails, as the scheduler heartbeat ages", () => {
    assert.strictEqual(
      statusOf(serverCheck({ version: "1", schedulerHeartbeatAgeMs: null })),
      "ok",
    );
    assert.strictEqual(
      statusOf(serverCheck({ version: "1", schedulerHeartbeatAgeMs: 5_000 })),
      "ok",
    );
    assert.strictEqual(
      statusOf(serverCheck({ version: "1", schedulerHeartbeatAgeMs: 25_000 })),
      "warn",
    );
    const stalled = serverCheck({ version: "1", schedulerHeartbeatAgeMs: 120_000 });
    assert.strictEqual(stalled.status, "fail");
    assert.strictEqual(stalled.items[0]?.key, "server:scheduler");
  });
});

describe("diskCheck", () => {
  it("applies the absolute and relative thresholds", () => {
    const total = 1000 * GB;
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 500 * GB, totalBytes: total })), "ok");
    // Plenty of bytes but under 10% of a large disk.
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 90 * GB, totalBytes: total })), "warn");
    // Under 3% fails even with many gigabytes left.
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 20 * GB, totalBytes: total })), "fail");
    // Small disk: the byte floors decide.
    assert.strictEqual(
      statusOf(diskCheck({ freeBytes: DISK_WARN_FREE_BYTES - 1, totalBytes: 40 * GB })),
      "warn",
    );
    const full = diskCheck({ freeBytes: DISK_FAIL_FREE_BYTES - 1, totalBytes: 40 * GB });
    assert.strictEqual(full.status, "fail");
    assert.strictEqual(full.items[0]?.key, "disk:free");
  });
});

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(0),
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("providersCheck", () => {
  it("fails a signed-out provider with a sign-in fix and ignores disabled ones", () => {
    const result = providersCheck({
      providers: [
        provider(),
        provider({
          instanceId: ProviderInstanceId.make("codex"),
          displayName: "Codex",
          auth: { status: "unauthenticated" },
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          auth: { status: "unauthenticated" },
        }),
      ],
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.summary, "1 of 2 providers signed in");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.fix, entry.target]),
      [
        [
          "providers:codex:auth",
          "sign-in",
          { _tag: "provider", instanceId: ProviderInstanceId.make("codex") },
        ],
      ],
    );
  });

  it("warns for exhausted and nearly exhausted usage windows with the reset time", () => {
    const resetsAt = DateTime.formatIso(ago(-minutes(90)));
    const result = providersCheck({
      providers: [
        provider({
          usageLimits: {
            checkedAt: iso(0),
            windows: [
              { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100, resetsAt },
              { id: "seven_day", kind: "weekly", label: "weekly", usedPercent: 93 },
              { id: "monthly", kind: "monthly", label: "monthly", usedPercent: 40 },
              // Already reset: stale until the next probe.
              { id: "old", kind: "other", label: "old", usedPercent: 100, resetsAt: iso(1) },
            ],
          },
        }),
      ],
      now,
    });
    assert.strictEqual(result.status, "warn");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.title, entry.detail]),
      [
        [
          "providers:claude:usage:five_hour",
          "Claude has used its 5-hour limit",
          `It resets at ${resetsAt}.`,
        ],
        ["providers:claude:usage:seven_day", "Claude is at 93% of its weekly limit", ""],
      ],
    );
  });

  it("warns when no provider is enabled", () => {
    assert.strictEqual(
      statusOf(providersCheck({ providers: [provider({ enabled: false })], now })),
      "warn",
    );
  });
});

describe("peerReachabilityItem", () => {
  const peer = { environmentId: vps, name: "Contabo VPS", pairing: "paired" as const, now };

  it("is null while the peer is online", () => {
    assert.isNull(peerReachabilityItem({ ...peer, online: true, lastSeenAt: null }));
  });

  it("warns under ten minutes offline and fails at ten or more", () => {
    const recent = peerReachabilityItem({ ...peer, online: false, lastSeenAt: ago(minutes(3)) });
    assert.strictEqual(recent?.status, "warn");
    assert.strictEqual(recent?.title, "Contabo VPS hasn't been reachable for 3 minutes");
    assert.strictEqual(recent?.key, `machine-links:reachable:${vps}`);
    assert.deepStrictEqual(recent?.target, { _tag: "machine", environmentId: vps });

    const long = peerReachabilityItem({
      ...peer,
      online: false,
      lastSeenAt: ago(Duration.toMillis(PEER_OFFLINE_FAIL_AFTER)),
    });
    assert.strictEqual(long?.status, "fail");
    assert.strictEqual(long?.title, "Contabo VPS hasn't been reachable for 10 minutes");
  });

  it("fails a revoked pairing even when online, and a peer never seen", () => {
    assert.strictEqual(
      peerReachabilityItem({ ...peer, pairing: "revoked", online: true, lastSeenAt: null })?.status,
      "fail",
    );
    assert.strictEqual(
      peerReachabilityItem({ ...peer, online: false, lastSeenAt: null })?.status,
      "fail",
    );
  });

  it("builds an unreachable report around the item", () => {
    const offline = peerReachabilityItem({ ...peer, online: false, lastSeenAt: ago(minutes(12)) });
    assert.isNotNull(offline);
    if (offline === null) return;
    const report = unreachableReport({
      environmentId: vps,
      name: "Contabo VPS",
      item: offline,
      now,
    });
    assert.isFalse(report.reachable);
    assert.strictEqual(report.status, "fail");
    assert.deepStrictEqual(
      report.checks.map((entry) => entry.id),
      ["machine-links"],
    );
  });
});

const machine = (overrides: Partial<MachineInfo>): MachineInfo => ({
  environmentId: vps,
  name: "Contabo VPS",
  kind: "cloud-server",
  hardware: "server",
  platform: "linux",
  relation: "hub",
  online: true,
  lastSeenAt: null,
  pairedAt: ago(minutes(600)),
  pairing: "paired",
  providers: [],
  ...overrides,
});

describe("machineLinksCheck", () => {
  it("reports offline direct peers and skips this machine and indirect ones", () => {
    const result = machineLinksCheck({
      machines: [
        machine({ environmentId: self, relation: "this", name: "Laptop" }),
        machine({ online: false, lastSeenAt: ago(minutes(20)) }),
        machine({
          environmentId: EnvironmentId.make("env-other"),
          relation: "peer",
          online: false,
        }),
      ],
      link: {
        _tag: "spoke",
        hubEnvironmentId: vps,
        status: "offline",
        route: null,
        lastError: null,
      },
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.summary, "0 of 1 machine online");
    assert.strictEqual(result.items.length, 1);
  });

  it("fails an untrusted hub", () => {
    const result = machineLinksCheck({
      machines: [machine({ online: false, lastSeenAt: ago(minutes(1)) })],
      link: {
        _tag: "spoke",
        hubEnvironmentId: vps,
        status: "untrusted",
        route: null,
        lastError: null,
      },
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.items[0]?.title, "Contabo VPS couldn't prove its identity");
  });

  it("is ok with no pairings", () => {
    assert.strictEqual(
      statusOf(machineLinksCheck({ machines: [], link: { _tag: "standalone" }, now })),
      "ok",
    );
  });
});

describe("sync tracking", () => {
  const sample = (overrides: Partial<SyncPeerSample> = {}): SyncPeerSample => ({
    environmentId: vps,
    name: "Contabo VPS",
    online: true,
    backlog: 3,
    acknowledged: "1:1:1",
    heldChanges: 0,
    heldThreads: 0,
    ...overrides,
  });

  it("flags a backlog whose acknowledgements don't move for five minutes", () => {
    const first = trackSyncProgress(undefined, sample(), NOW_MS);
    const later = NOW_MS + SYNC_STUCK_AFTER_MS;
    const still = trackSyncProgress(first, sample(), later);
    assert.strictEqual(still.pendingSinceMs, NOW_MS);
    const result = syncCheck({ peers: [{ sample: sample(), progress: still }], nowMs: later });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.items[0]?.key, `sync:stuck:${vps}`);
    assert.strictEqual(result.items[0]?.fix, "retry-sync");
  });

  it("restarts the clock when acknowledgements move, and clears it once in sync", () => {
    const first = trackSyncProgress(undefined, sample(), NOW_MS);
    const moved = trackSyncProgress(first, sample({ acknowledged: "2:1:1" }), NOW_MS + 60_000);
    assert.strictEqual(moved.pendingSinceMs, NOW_MS + 60_000);
    const synced = trackSyncProgress(moved, sample({ backlog: 0 }), NOW_MS + 120_000);
    assert.isNull(synced.pendingSinceMs);
    assert.strictEqual(synced.inSyncAtMs, NOW_MS + 120_000);
  });

  it("doesn't judge an offline peer's backlog, and warns about held changes", () => {
    const offline = sample({ online: false, heldChanges: 2, heldThreads: 1 });
    const progress = trackSyncProgress(
      { acknowledged: "1:1:1", pendingSinceMs: NOW_MS - minutes(60), inSyncAtMs: null },
      offline,
      NOW_MS,
    );
    assert.isNull(progress.pendingSinceMs);
    const result = syncCheck({ peers: [{ sample: offline, progress }], nowMs: NOW_MS });
    assert.strictEqual(result.status, "warn");
    assert.deepStrictEqual(
      result.items.map((entry) => entry.key),
      [`sync:held:${vps}`],
    );
  });
});

describe("integrationsCheck", () => {
  const summary = (
    name: string,
    status: IntegrationSummary["status"],
    enabled = true,
  ): IntegrationSummary => ({
    integration: {
      id: IntegrationId.make(`id-${name}`),
      name,
      displayName: name.toUpperCase(),
      transport: "http",
      url: "https://example.com/mcp",
      headers: {},
      enabled,
      scope: { type: "all" },
      hint: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    },
    status,
    toolCount: null,
  });

  it("warns for sign-in, fails for errors, and skips disabled integrations", () => {
    const result = integrationsCheck({
      integrations: [
        summary("gmail", "needs_sign_in"),
        summary("linear", "error"),
        summary("notion", "connected"),
        summary("old", "error", false),
      ],
    });
    assert.strictEqual(result.status, "fail");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.status, entry.fix]),
      [
        ["integrations:gmail", "warn", "sign-in"],
        ["integrations:linear", "fail", null],
      ],
    );
  });
});

const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
  id: ScheduledTaskId.make("task-1"),
  title: "Morning brief",
  prompt: "Summarize my day",
  enabled: true,
  schedule: { type: "interval", everyMs: minutes(60) },
  projectId: ProjectId.make("project-1"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: iso(minutes(600)),
  updatedAt: iso(minutes(600)),
  nextRunAt: iso(-minutes(30)),
  lastRunAt: iso(minutes(30)),
  lastRunStatus: "succeeded",
  lastRunError: null,
  runCount: 3,
  ...overrides,
});

describe("scheduledTasksCheck", () => {
  it("is ok for tasks on time", () => {
    const result = scheduledTasksCheck({ tasks: [task({})], environmentId: self, now });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.summary, "1 scheduled task on track");
  });

  it("detects failed, overdue and stuck runs, keyed by task", () => {
    const result = scheduledTasksCheck({
      tasks: [
        task({ id: ScheduledTaskId.make("failed"), lastRunStatus: "failed" }),
        task({
          id: ScheduledTaskId.make("overdue"),
          nextRunAt: iso(SCHEDULED_TASK_OVERDUE_GRACE_MS + 1),
        }),
        // Due a moment ago: within the grace period.
        task({ id: ScheduledTaskId.make("due"), nextRunAt: iso(minutes(1)) }),
        task({
          id: ScheduledTaskId.make("stuck"),
          lastRunStatus: "running",
          lastRunAt: iso(SCHEDULED_TASK_STUCK_AFTER_MS),
        }),
        task({
          id: ScheduledTaskId.make("starting"),
          lastRunStatus: "running",
          lastRunAt: iso(1),
        }),
      ],
      environmentId: self,
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.fix]),
      [
        ["scheduled-tasks:failed", "run-now"],
        ["scheduled-tasks:overdue", "run-now"],
        ["scheduled-tasks:stuck", null],
      ],
    );
    assert.deepStrictEqual(result.items[0]?.target, {
      _tag: "scheduledTask",
      taskId: ScheduledTaskId.make("failed"),
    });
  });

  it("ignores disabled tasks and tasks another machine runs", () => {
    const result = scheduledTasksCheck({
      tasks: [
        task({ enabled: false, lastRunStatus: "failed" }),
        task({ ownerMachine: vps, lastRunStatus: "failed" }),
        task({ ownerMachine: self, id: ScheduledTaskId.make("mine"), lastRunStatus: "failed" }),
      ],
      environmentId: self,
      now,
    });
    assert.deepStrictEqual(
      result.items.map((entry) => entry.key),
      ["scheduled-tasks:mine"],
    );
  });
});

describe("stuckRunsCheck", () => {
  it("fails runs and subagents active past the limit, targeting the thread", () => {
    const threadId = ThreadId.make("thread-1");
    const active = (kind: "run" | "subagent", id: string, threadTitle: string, age: number) => ({
      kind,
      id,
      threadId,
      threadTitle,
      startedAt: ago(age),
    });
    const result = stuckRunsCheck({
      active: [
        active("run", "run-1", "Fix login", STUCK_RUN_AFTER_MS),
        active("subagent", "sub-1", "Fix login", STUCK_RUN_AFTER_MS + 1),
        active("run", "run-2", "Recent", minutes(5)),
      ],
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.fix, entry.target]),
      [
        ["stuck-runs:subagent:sub-1", "resume", { _tag: "thread", threadId }],
        ["stuck-runs:run:run-1", "resume", { _tag: "thread", threadId }],
      ],
    );
    assert.strictEqual(result.items[1]?.title, `"Fix login" has been running for 6 hours`);
  });
});
