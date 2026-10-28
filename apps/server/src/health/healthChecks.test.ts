import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  IntegrationId,
  type IntegrationSummary,
  MachineHealthCheck,
  MachineHealthItem,
  MachineHealthReport,
  MachineHealthAlert,
  type MachineInfo,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import {
  DISK_FAIL_FREE_BYTES,
  DISK_FAIL_LOW_FREE_BYTES,
  DISK_WARN_FREE_BYTES,
  SCHEDULED_TASK_OVERDUE_GRACE_MS,
  SCHEDULED_TASK_STUCK_AFTER_MS,
  STUCK_RUN_AFTER_MS,
  SYNC_STUCK_AFTER_MS,
  type SyncPeerSample,
  buildReport,
  directlyFixableItemKeys,
  quarantinedThreadItem,
  agentProcessesCheck,
  chatSandboxCheck,
  previewBrowserCheck,
  diskCheck,
  databaseCheck,
  integrationsCheck,
  machineLinksCheck,
  providersCheck,
  rateLimitItems,
  sameReportContent,
  scheduledTasksCheck,
  serverCheck,
  stuckRunsCheck,
  syncCheck,
  tailscaleServeCheck,
  trackSyncProgress,
  worstStatus,
} from "./healthChecks.ts";
import {
  PEER_CONNECT_GRACE,
  PEER_OFFLINE_FAIL_AFTER,
  peerReachabilityItem,
  unreachableReport,
} from "./peerReachability.ts";
import {
  buildMachineSetupStatus,
  emptyProgress,
  type MachineSetupObservation,
} from "../tailscale/machineSetupSteps.ts";

const NOW_MS = Date.parse("2026-10-24T12:00:00.000Z");
const now = DateTime.makeUnsafe(NOW_MS);
const ago = (ms: number) => DateTime.makeUnsafe(NOW_MS - ms);
const iso = (ms: number) => DateTime.formatIso(ago(ms));
const minutes = (count: number) => count * 60_000;
const days = (count: number) => count * 24 * 60 * 60_000;
const seconds = (count: number) => count * 1000;
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
    assert.isTrue(
      sameReportContent(first, {
        ...later,
        resources: {
          sampledAt: 1,
          cpuCores: 4,
          loadAverage1m: 1,
          loadAverage5m: 0,
          availableMemoryBytes: 1000,
          totalMemoryBytes: 2000,
        },
      }),
    );
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
  it("warns only when free space is small in bytes and in share", () => {
    const total = 1000 * GB;
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 500 * GB, totalBytes: total })), "ok");
    // Tens of gigabytes on a big disk stay quiet, even under 10% (36.6 GB of 460 GB).
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 90 * GB, totalBytes: total })), "ok");
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 36.6 * GB, totalBytes: 460 * GB })), "ok");
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 20 * GB, totalBytes: total })), "ok");
    // Under 10 GB and under 10% warns.
    assert.strictEqual(statusOf(diskCheck({ freeBytes: 8 * GB, totalBytes: total })), "warn");
    // Under 10 GB but a large share of a small disk stays quiet.
    assert.strictEqual(
      statusOf(diskCheck({ freeBytes: DISK_WARN_FREE_BYTES - 1, totalBytes: 40 * GB })),
      "ok",
    );
    // Under 5 GB and under 3% fails.
    assert.strictEqual(
      statusOf(diskCheck({ freeBytes: DISK_FAIL_LOW_FREE_BYTES - 1, totalBytes: total })),
      "fail",
    );
    // Under 1 GB fails whatever the share.
    const full = diskCheck({ freeBytes: DISK_FAIL_FREE_BYTES - 1, totalBytes: 8 * GB });
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

  it("warns once an account is rate-limited repeatedly, naming the likely cause", () => {
    const codex = ProviderInstanceId.make("codex");
    const items = rateLimitItems({
      providers: [provider({ instanceId: codex, displayName: "Codex" })],
      streaks: [
        { providerInstanceId: codex, count: 5, latestAt: ago(minutes(4)) },
        // Below the repeat threshold: an occasional 429 is not an item.
        { providerInstanceId: ProviderInstanceId.make("claude"), count: 2, latestAt: now },
      ],
    });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0]?.key, "providers:codex:rate-limited");
    assert.strictEqual(items[0]?.status, "warn");
    assert.include(items[0]?.title ?? "", "rate-limited repeatedly");
    assert.include(items[0]?.detail ?? "", "5 rate limits in the last hour");
    assert.include(items[0]?.detail ?? "", "too many concurrent threads on one account");
  });
});

describe("peerReachabilityItem", () => {
  const peer = {
    environmentId: vps,
    name: "Contabo VPS",
    pairing: "paired" as const,
    pairedAt: null,
    now,
  };

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

  it("reads as connecting, not failing, within the grace of pairing or last being seen", () => {
    const justPaired = peerReachabilityItem({
      ...peer,
      online: false,
      lastSeenAt: null,
      pairedAt: ago(seconds(5)),
    });
    assert.strictEqual(justPaired?.status, "unknown");
    assert.strictEqual(justPaired?.title, "Connecting to Contabo VPS…");
    assert.strictEqual(
      peerReachabilityItem({ ...peer, online: false, lastSeenAt: ago(seconds(30)) })?.status,
      "unknown",
    );
    const neverCameUp = peerReachabilityItem({
      ...peer,
      online: false,
      lastSeenAt: null,
      pairedAt: ago(Duration.toMillis(PEER_CONNECT_GRACE)),
    });
    assert.strictEqual(neverCameUp?.status, "fail");
  });

  it("keeps timestamps out of the detail", () => {
    const item = peerReachabilityItem({ ...peer, online: false, lastSeenAt: ago(minutes(3)) });
    assert.notMatch(item?.detail ?? "", /\d{4}-\d{2}-\d{2}T/);
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

  it("reports quarantined history without suggesting a deterministic retry", () => {
    const peer = sample({ heldChanges: 3, heldThreads: 1, quarantined: 3, backlog: 0 });
    const result = syncCheck({
      peers: [{ sample: peer, progress: trackSyncProgress(undefined, peer, NOW_MS) }],
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({
      status: "fail",
      items: [
        {
          key: `sync:quarantined:${vps}`,
          status: "fail",
          fix: null,
          target: { _tag: "machine", environmentId: vps },
        },
      ],
    });
  });

  it("flags a backlog whose acknowledgements don't move for five minutes", () => {
    const first = trackSyncProgress(undefined, sample(), NOW_MS);
    const later = NOW_MS + SYNC_STUCK_AFTER_MS;
    const still = trackSyncProgress(first, sample(), later);
    assert.strictEqual(still.pendingSinceMs, NOW_MS);
    const result = syncCheck({ peers: [{ sample: sample(), progress: still }], nowMs: later });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(
      result.items.find((entry) => entry.key === `sync:stuck:${vps}`)?.key,
      `sync:stuck:${vps}`,
    );
    assert.strictEqual(
      result.items.find((entry) => entry.key === `sync:stuck:${vps}`)?.fix,
      "retry-sync",
    );
  });

  it("shows catch-up progress, measured rate and estimated time remaining", () => {
    const current = sample({ backlog: 300, ratePerSecond: 50 });
    const result = syncCheck({
      peers: [{ sample: current, progress: trackSyncProgress(undefined, current, NOW_MS) }],
      nowMs: NOW_MS,
    });
    assert.strictEqual(result.items[0]?.title, "Catching up Contabo VPS");
    assert.include(result.items[0]?.detail, "300 changes pending");
    assert.include(result.items[0]?.detail, "50.0 changes/s");
    assert.include(result.items[0]?.detail, "remaining");
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
    assert.strictEqual(result.summary, "1 failing, 1 needs attention");
  });

  it("words its summary like its status", () => {
    const failing = integrationsCheck({
      integrations: [summary("linear", "error"), summary("notion", "connected")],
    });
    assert.strictEqual(failing.summary, "1 of 2 integrations is failing");
    const signIn = integrationsCheck({
      integrations: [summary("gmail", "needs_sign_in"), summary("notion", "connected")],
    });
    assert.strictEqual(signIn.summary, "1 of 2 integrations needs attention");
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
  const active = (
    kind: "run" | "subagent",
    id: string,
    thread: string,
    threadTitle: string,
    age: number,
  ) => ({ kind, id, threadId: ThreadId.make(thread), threadTitle, startedAt: ago(age) });

  // 0.3.1 has the same report/alert structure, but only these Fix literals.
  const legacyFix = Schema.NullOr(
    Schema.Literals(["sign-in", "run-now", "resume", "retry-sync", "setup-sandbox"]),
  );
  const legacyItem = Schema.Struct({ ...MachineHealthItem.fields, fix: legacyFix });
  const legacyReport = Schema.Struct({
    ...MachineHealthReport.fields,
    checks: Schema.Array(
      Schema.Struct({ ...MachineHealthCheck.fields, items: Schema.Array(legacyItem) }),
    ),
  });
  const legacyAlert = Schema.Struct({ ...MachineHealthAlert.fields, fix: legacyFix });

  const encodeReport = Schema.encodeSync(Schema.toCodecJson(MachineHealthReport));
  const encodeAlert = Schema.encodeSync(Schema.toCodecJson(MachineHealthAlert));
  const decoders = {
    "0.3.2 to 0.3.1": {
      report: Schema.decodeUnknownSync(Schema.toCodecJson(legacyReport)),
      alert: Schema.decodeUnknownSync(Schema.toCodecJson(legacyAlert)),
    },
    "0.3.1 to 0.3.2": {
      report: Schema.decodeUnknownSync(Schema.toCodecJson(MachineHealthReport)),
      alert: Schema.decodeUnknownSync(Schema.toCodecJson(MachineHealthAlert)),
    },
  };
  it.each(["0.3.2 to 0.3.1", "0.3.1 to 0.3.2"] as const)(
    "decodes stuck-run reports and alerts from %s",
    (direction) => {
      const check = stuckRunsCheck({
        active: [active("run", "old", "thread", "Old", STUCK_RUN_AFTER_MS + 1)],
        now,
      });
      const report = {
        environmentId: self,
        machineName: "MacBook",
        status: check.status,
        observedAt: now,
        serverVersion: direction.startsWith("0.3.2") ? "0.3.2" : "0.3.1",
        uptimeSeconds: 1,
        reachable: true,
        checks: [check],
      };
      const alert = {
        id: "alert:old",
        originEnvironmentId: self,
        originMachineName: "MacBook",
        itemKey: check.items[0]!.key,
        checkId: "stuck-runs" as const,
        state: "open" as const,
        status: check.status,
        title: "Stuck",
        detail: "",
        openedAt: now,
        resolvedAt: null,
        target: check.items[0]!.target,
        fix: check.items[0]!.fix,
      };
      const reportJson = encodeReport(report);
      const alertJson = encodeAlert(alert);
      expect(decoders[direction].report(reportJson).checks[0]!.items[0]!.fix).toBe("resume");
      expect(decoders[direction].alert(alertJson).fix).toBe("resume");
    },
  );

  it("one item per thread, past the limit, with a Fix that stops them", () => {
    const result = stuckRunsCheck({
      active: [
        active("run", "run-1", "thread-1", "Fix login", STUCK_RUN_AFTER_MS),
        active("subagent", "sub-1", "thread-1", "Fix login", STUCK_RUN_AFTER_MS + 1),
        active("run", "run-2", "thread-2", "Recent", minutes(5)),
      ],
      now,
    });
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.summary, "2 stuck runs");
    assert.deepStrictEqual(
      result.items.map((entry) => [entry.key, entry.fix, entry.target, entry.title]),
      [
        [
          "stuck-runs:thread:thread-1",
          "resume",
          { _tag: "thread", threadId: ThreadId.make("thread-1") },
          `"Fix login" and 1 subagent stuck for 6 hours`,
        ],
      ],
    );
  });

  it("collapses many stuck subagents in one thread into one counted item", () => {
    const title = "Athens Racing Master: Fixes, Kifissia & Riviera";
    const result = stuckRunsCheck({
      active: [
        ...Array.from({ length: 18 }, (_, index) =>
          active("subagent", `sub-${index}`, "athens", title, days(2) + index),
        ),
        active("subagent", "other", "thread-3", "Other", STUCK_RUN_AFTER_MS),
      ],
      now,
    });
    assert.strictEqual(result.summary, "19 stuck runs in 2 threads");
    assert.deepStrictEqual(
      result.items.map((entry) => entry.title),
      [
        `18 subagents stuck in "Athens Racing Master: Fixes, Kifissia & Riviera" for 2 days`,
        `A subagent in "Other" has been running for 6 hours`,
      ],
    );
  });
});

describe("tailscaleServeCheck", () => {
  const setup = (overrides: Partial<MachineSetupObservation>) =>
    buildMachineSetupStatus(
      {
        machineName: "Contabo VPS",
        host: { platform: "linux", root: false, passwordlessSudo: false, homebrew: false },
        installed: true,
        version: "1.104.2",
        status: {
          backendState: "Running",
          authUrl: null,
          magicDnsName: "contabo-vps.tail300b9e.ts.net",
          tailnetName: "alex@example.com",
          httpsEnabled: true,
        },
        serveMappings: [],
        localPort: 4773,
        serveMode: { enabled: true, servePort: 443 },
        progress: emptyProgress,
        ...overrides,
      },
      now,
    );

  it("serves when the mapping points at this server's port", () => {
    const result = tailscaleServeCheck({
      serveEnabled: true,
      setup: setup({
        serveMappings: [{ port: 443, target: "http://127.0.0.1:4773", funnel: false }],
      }),
    });
    expect(result).toMatchObject({
      status: "ok",
      summary: "Serving at https://contabo-vps.tail300b9e.ts.net/",
    });
  });

  it("doesn't call a restart broken while Cogenly points Serve back at this run", () => {
    // Reconciliation also allows tailscaled to come up after the server.
    const restarting = tailscaleServeCheck({
      serveEnabled: true,
      setup: setup({ progress: { ...emptyProgress, working: new Set(["expose"]) } }),
    });
    expect(restarting).toMatchObject({ status: "ok", items: [] });
    expect(
      tailscaleServeCheck({
        serveEnabled: true,
        setup: setup({
          status: null,
          progress: { ...emptyProgress, working: new Set(["expose"]) },
        }),
      }),
    ).toMatchObject({ status: "ok", items: [] });
    const broken = tailscaleServeCheck({ serveEnabled: true, setup: setup({}) });
    expect(broken).toMatchObject({
      status: "fail",
      summary: "Tailscale Serve isn't forwarding to this server",
    });
  });
});

it("chat sandbox health offers provisioning only for repairable failures", () => {
  const missing = chatSandboxCheck({
    available: false,
    failure: "bwrap-missing",
    reason: "bubblewrap isn't installed",
  });
  expect(missing.status).toBe("warn");
  expect(missing.items[0]).toMatchObject({
    title: "Chat commands are off: bubblewrap isn't installed",
    fix: "setup-sandbox",
  });
  expect(
    chatSandboxCheck({
      available: false,
      failure: "seccomp-unsupported",
      reason: "seccomp unavailable",
    }).items[0]?.fix,
  ).toBeNull();
  expect(chatSandboxCheck({ available: true, backend: "bwrap" })).toMatchObject({
    status: "ok",
    items: [],
  });
});

describe("machine version skew", () => {
  const self = machine({
    environmentId: EnvironmentId.make("self"),
    name: "MacBook",
    relation: "this",
    pairing: "self",
    serverVersion: "0.3.3",
  });
  const inspect = (peers: ReadonlyArray<MachineInfo>) =>
    machineLinksCheck({
      machines: [self, ...peers],
      link: { _tag: "hub", spokes: peers.length },
      now,
    });
  it("warns on older peers, with a direct fix for peers that support it", () => {
    const result = inspect([machine({ serverVersion: "0.3.3-staging.1", relation: "spoke" })]);
    expect(result.status).toBe("warn");
    expect(result.items[0]).toMatchObject({ title: "Update Contabo VPS to match", fix: null });
    const newer = inspect([machine({ serverVersion: "0.3.4" })]);
    expect(newer.items[0]).toMatchObject({
      title: "Update MacBook to match",
      fix: "update-machine",
      target: { _tag: "machine", environmentId: self.environmentId },
    });
  });
  it("offers a peer update, and leaves offline machines manual", () => {
    const source = machine({ serverVersion: "0.3.4", environmentId: EnvironmentId.make("newer") });
    const old = machine({ serverVersion: "0.3.3", relation: "spoke" });
    expect(
      inspect([source, old]).items.find(
        (item) =>
          item.target?._tag === "machine" && item.target.environmentId === old.environmentId,
      )?.fix,
    ).toBe("update-machine");
    expect(
      inspect([source, { ...old, online: false }]).items.find(
        (item) => item.key === `machine-version:${old.environmentId}`,
      )?.fix,
    ).toBeNull();
  });
  it("clears after versions match and tolerates 0.3.2 lists without versions", () => {
    expect(inspect([machine({ serverVersion: "0.3.3" })]).items).toEqual([]);
    expect(inspect([machine({})]).items).toEqual([]);
  });
});

it("agent process health warns about live orphans only, with a Fix", () => {
  const live = { orphaned: false, command: "npm run dev", pids: [10] };
  expect(agentProcessesCheck({ processes: [live] })).toMatchObject({ status: "ok", items: [] });
  // An orphan whose processes all exited is nothing to fix.
  expect(
    agentProcessesCheck({ processes: [{ orphaned: true, command: "gone", pids: [] }] }).status,
  ).toBe("ok");
  const check = agentProcessesCheck({
    processes: [live, { orphaned: true, command: "vite --port 5173\necho done", pids: [20, 21] }],
  });
  expect(check.status).toBe("warn");
  expect(check.items[0]).toMatchObject({
    key: "agent-processes:orphaned",
    title: "1 orphaned agent command still running",
    fix: "kill-orphans",
  });
  expect(check.items[0]?.detail).toContain('"vite --port 5173" (2 processes)');
});

it("names the quarantine and volume, and requires an explicit item for discard", () => {
  const held = quarantinedThreadItem({
    threadId: ThreadId.make("thread:bad"),
    title: "Brakes",
    count: 7,
    bytes: 2048,
  });
  expect(held).toMatchObject({
    title: "Discard quarantined changes for Brakes",
    fix: "discard-quarantined",
    detail: expect.stringContaining("7 incoming items (2048 bytes)"),
    target: { _tag: "thread", threadId: "thread:bad" },
  });
  const report = buildReport({
    environmentId: EnvironmentId.make("self"),
    machineName: "MacBook",
    observedAt: DateTime.makeUnsafe(0),
    serverVersion: "0.3.3",
    uptimeSeconds: 1,
    checks: [{ id: "sync", status: "fail", summary: "Quarantined", items: [held] }],
  });
  expect(directlyFixableItemKeys(report)).toEqual([]);
});

it("reports a warning while database writes use the main-thread fallback", () => {
  expect(
    databaseCheck({ answered: true, sizeBytes: 4096, writerWorkerUnavailable: true }),
  ).toMatchObject({
    status: "warn",
    items: [{ key: "database:writer-worker", status: "warn" }],
  });
  expect(
    databaseCheck({ answered: true, sizeBytes: 4096, writerWorkerUnavailable: false }).status,
  ).toBe("ok");
});

it("chat sandbox health distinguishes AppArmor userns blocking from missing bubblewrap", () => {
  const blocked = chatSandboxCheck({
    available: false,
    failure: "apparmor-userns",
    reason: "bubblewrap is blocked by AppArmor user-namespace restriction",
  });
  expect(blocked.items[0]).toMatchObject({
    title: "Chat commands are off: bubblewrap is blocked by AppArmor user-namespace restriction",
    fix: "setup-sandbox",
  });
  expect(blocked.items[0]?.detail).toContain("kernel.apparmor_restrict_unprivileged_userns=1");
  expect(blocked.items[0]?.detail).toContain("/etc/apparmor.d/cogenly-bwrap");
  expect(blocked.items[0]?.detail).toContain("flags=(unconfined)");
  expect(blocked.items[0]?.detail).toContain("apparmor_parser -r");
  expect(blocked.items[0]?.detail).toContain("global restriction stays on");
  expect(blocked.items[0]?.detail).not.toContain("installs the distro bubblewrap package");
});

it("browser host problems retain an actionable Fix without changing sandbox policy", () => {
  const check = previewBrowserCheck({
    state: "ready",
    detail: "Installed",
    hostProblem: "Run `sudo cogenly browser setup` on the host.",
  });
  expect(check.items[0]).toMatchObject({
    key: "preview-browser:host",
    status: "fail",
    fix: "setup-browser",
    detail: expect.stringContaining("sudo cogenly browser setup"),
  });
});
