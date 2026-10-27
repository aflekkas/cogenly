import { describe, expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthPeerDelegateScope,
  AuthProvidersManageScope,
  AuthSyncReplicateScope,
  EnvironmentId,
  MachineHealthError,
  MachineHealthAlertsRead,
  MachineHealthFixRun,
  MachineHealthTurnOffProviderRun,
  MachineVersionUpdate,
  ProviderInstanceId,
  type MachineHealthFixResult,
  type MachineHealthItem,
  type MachineHealthReport,
  type MachineInfo,
  type MachineSelfReport,
  type PeerChannel,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Integrations from "../integrations/Integrations.ts";
import * as HealthAlerts from "./HealthAlerts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HealthAlertsState from "./HealthAlertsState.ts";
import * as MachineHealth from "./MachineHealth.ts";
import * as MachineHealthFixes from "./MachineHealthFixes.ts";
import { summarizeFixOutcomes } from "./MachineHealthFixes.ts";

const laptop = EnvironmentId.make("laptop");
const vps = EnvironmentId.make("vps");
const offline = EnvironmentId.make("offline");
const taskId = ScheduledTaskId.make("task:nightly");

const item = (key: string, fix: MachineHealthItem["fix"], target: MachineHealthItem["target"]) =>
  ({ key, status: "fail", title: key, detail: "", since: null, target, fix }) as const;

const report: MachineHealthReport = {
  environmentId: laptop,
  machineName: "MacBook",
  status: "fail",
  observedAt: DateTime.makeUnsafe(0),
  serverVersion: "0.3.2",
  uptimeSeconds: 1,
  reachable: true,
  checks: [
    {
      id: "scheduled-tasks",
      status: "fail",
      summary: "",
      items: [item("scheduled-tasks:nightly", "run-now", { _tag: "scheduledTask", taskId })],
    },
    {
      id: "integrations",
      status: "fail",
      summary: "",
      items: [item("integrations:linear", null, { _tag: "integration", name: "linear" })],
    },
  ],
};

const fromVps: MachineHealthFixResult = {
  environmentId: vps,
  machineName: "Cloud server",
  summary: "Stopped 18 stuck subagents.",
  outcomes: [{ itemKey: "stuck-runs:thread:a", status: "fixed", message: "Stopped." }],
};

const syncCheck = {
  id: "sync",
  status: "fail",
  summary: "",
  items: [
    item("sync:quarantined-thread:thread:bad", "discard-quarantined", {
      _tag: "thread",
      threadId: ThreadId.make("thread:bad"),
    }),
    item(`sync:quarantined:${vps}`, "retry-sync", {
      _tag: "machine",
      environmentId: vps,
    }),
  ],
} as const;

const harness = (
  withVersionItem = false,
  capability: "boot-service" | "desktop-managed" | null = "boot-service",
  browserProblem = false,
  auto: {
    readonly report?: MachineHealthReport;
    readonly enabled?: boolean;
    readonly database?: Layer.Layer<SqlClient.SqlClient>;
    readonly scheduler?: Scheduler.Scheduler["Service"];
    readonly retried?: Deferred.Deferred<void>;
    readonly withAlerts?: boolean;
    readonly afterRetry?: () => void;
  } = {},
) =>
  Effect.gen(function* () {
    const ran: Array<string> = [];
    const retried: Array<EnvironmentId> = [];
    const peerCalls: Array<{ environmentId: EnvironmentId; channel: string; payload: unknown }> =
      [];
    const self: MachineSelfReport = {
      environmentId: laptop,
      name: "MacBook",
      role: "computer",
      hardware: "laptop",
      platform: "darwin",
      serverVersion: "0.3.3",
      providers: [],
    };
    const call = ((environmentId: EnvironmentId, channel: PeerChannel, payload: unknown) =>
      Effect.sync(() => {
        peerCalls.push({ environmentId, channel: channel.name, payload });
        if (channel.name === MachineHealthAlertsRead.name)
          return { open: [], recentlyResolved: [] };
        return fromVps;
      })) as unknown as Machines.Machines["Service"]["call"];
    const machine = (environmentId: EnvironmentId, relation: "this" | "hub"): MachineInfo => ({
      environmentId,
      name: relation === "this" ? "MacBook" : "Cloud server",
      kind: relation === "this" ? "this-computer" : "cloud-server",
      hardware: relation === "this" ? "laptop" : "server",
      platform: "linux",
      relation,
      online: true,
      lastSeenAt: null,
      pairedAt: null,
      pairing: relation === "this" ? "self" : "paired",
      providers: [],
      serverVersion: relation === "this" ? "0.3.3" : "0.3.4",
    });
    const context = yield* Layer.build(
      Layer.mergeAll(
        MachineHealthFixes.layer,
        ...(auto.withAlerts ? [HealthAlerts.layer] : []),
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(PreviewBrowser.PreviewBrowser)({
              setup: Effect.sync(() => {
                ran.push("install-browser");
                return "/test/browser";
              }),
            }),
            Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({
              capability,
              update: ({ targetVersion }) =>
                Effect.sync(() => {
                  ran.push(`update:${targetVersion}`);
                  return { targetVersion, method: "boot-service" as const, updateId: "test" };
                }),
            }),
            Layer.mock(MachineHealth.MachineHealth)({
              report: Effect.succeed(
                auto.report ??
                  (browserProblem
                    ? {
                        ...report,
                        checks: [
                          {
                            id: "preview-browser",
                            status: "warn",
                            summary: "Browser missing",
                            items: [item("preview-browser:install", "setup-browser", null)],
                          },
                        ],
                      }
                    : withVersionItem
                      ? {
                          ...report,
                          checks: [
                            {
                              id: "machine-links",
                              status: "warn",
                              summary: "Versions differ",
                              items: [
                                item(`machine-version:${laptop}`, "update-machine", {
                                  _tag: "machine",
                                  environmentId: laptop,
                                }),
                              ],
                            },
                            syncCheck,
                          ],
                        }
                      : { ...report, checks: [...report.checks, syncCheck] }),
              ),
              discardQuarantined: (threadId) =>
                Effect.sync(() => {
                  ran.push(`discard:${threadId}`);
                  return 7;
                }),
              retrySync: ({ environmentId }) =>
                environmentId === offline
                  ? Effect.fail(new MachineHealthError({ reason: "unavailable" }))
                  : Effect.gen(function* () {
                      retried.push(environmentId);
                      auto.afterRetry?.();
                      if (auto.retried) yield* Deferred.succeed(auto.retried, undefined);
                    }),
            }),
            Layer.mock(Machines.Machines)({
              list: Effect.succeed({
                machines: [machine(laptop, "this"), machine(vps, "hub")],
                link: { _tag: "standalone" as const },
              }),
              call,
            }),
            PeerChannels.layer,
            Layer.mock(Integrations.Integrations)({}),
            Layer.mock(MachineIdentity.MachineIdentity)({ self: Effect.succeed(self) }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ScheduledTasks.ScheduledTaskService)({
              runNow: (input) =>
                Effect.sync(() => {
                  ran.push(input.id);
                  return {} as never;
                }),
            }),
            auto.database ?? Sqlite.layerMemory,
            ServerSettings.layerTest({ health: { autoFix: auto.enabled ?? true } }),
            HealthAlertsState.layer,
            Layer.succeed(Scheduler.Scheduler, auto.scheduler ?? { register: () => Effect.void }),
            NodeCrypto.layer,
          ),
        ),
      ),
    );
    const fixes = yield* MachineHealthFixes.MachineHealthFixes.pipe(Effect.provideContext(context));
    const channels = yield* PeerChannels.PeerChannels.pipe(Effect.provideContext(context));
    const alertsState = yield* HealthAlertsState.HealthAlertsState.pipe(
      Effect.provideContext(context),
    );
    const settings = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.provideContext(context),
    );
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(context));
    const alerts = yield* Effect.serviceOption(HealthAlerts.HealthAlerts).pipe(
      Effect.provideContext(context),
    );
    return { fixes, channels, alertsState, settings, ran, peerCalls, retried, sql, alerts };
  });

describe("MachineHealthFixes", () => {
  it.effect("browser installation uses Fix and requires environment maintenance permission", () =>
    Effect.gen(function* () {
      const h = yield* harness(false, "boot-service", true);
      const denied = yield* h.fixes.fix({ itemKeys: ["preview-browser:install"] }, [
        AuthOrchestrationOperateScope,
      ]);
      expect(denied.outcomes[0]?.status).toBe("failed");
      expect(h.ran).toEqual([]);
      const fixed = yield* h.fixes.fix({ itemKeys: ["preview-browser:install"] }, [
        AuthEnvironmentMaintainScope,
      ]);
      expect(fixed.outcomes[0]?.status).toBe("fixed");
      expect(h.ran).toEqual(["install-browser"]);
    }).pipe(Effect.scoped),
  );

  it.effect("discards only the named quarantine through the peer Fix channel", () =>
    Effect.gen(function* () {
      const { channels, ran, retried } = yield* harness();
      const served = yield* channels.dispatch({
        channel: MachineHealthFixRun.name,
        payload: { itemKeys: ["sync:quarantined-thread:thread:bad"] },
        caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
      });
      expect(ran).toEqual(["discard:thread:bad"]);
      expect(retried).toEqual([]);
      expect(served).toMatchObject({
        outcomes: [
          { status: "fixed", message: expect.stringContaining("7 quarantined incoming items") },
        ],
      });
    }).pipe(Effect.scoped),
  );
  it.effect("retries quarantine through the peer Fix channel on the receiving machine", () =>
    Effect.gen(function* () {
      const { channels, retried } = yield* harness();
      const served = yield* channels.dispatch({
        channel: MachineHealthFixRun.name,
        payload: { itemKeys: [`sync:quarantined:${vps}`] },
        caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
      });
      expect(retried).toEqual([vps]);
      expect(served).toMatchObject({
        outcomes: [{ itemKey: `sync:quarantined:${vps}`, status: "fixed" }],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("runs direct fixes here and hands the rest to an agent", () =>
    Effect.gen(function* () {
      const { fixes, ran, peerCalls } = yield* harness();
      const result = yield* fixes.fix({
        itemKeys: ["scheduled-tasks:nightly", "integrations:linear", "disk:free"],
      });
      expect(ran).toEqual([taskId]);
      expect(peerCalls).toEqual([]);
      expect(result.outcomes.map((outcome) => [outcome.itemKey, outcome.status])).toEqual([
        ["scheduled-tasks:nightly", "fixed"],
        ["integrations:linear", "manual"],
        ["disk:free", "resolved"],
      ]);
      expect(result.summary).toBe(
        "Fixed 1 of 3. 1 had already cleared. 1 need an agent or you to look.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("runs a fix for another machine on that machine, over the peer link", () =>
    Effect.gen(function* () {
      const { fixes, ran, peerCalls } = yield* harness();
      const result = yield* fixes.fix({ environmentId: vps, itemKeys: ["stuck-runs:thread:a"] });
      expect(result).toEqual(fromVps);
      expect(peerCalls).toEqual([
        {
          environmentId: vps,
          channel: MachineHealthFixRun.name,
          payload: { itemKeys: ["stuck-runs:thread:a"] },
        },
      ]);
      expect(ran).toEqual([]);
      const unpaired = yield* fixes
        .fix({ environmentId: EnvironmentId.make("stranger"), itemKeys: ["x"] })
        .pipe(Effect.flip);
      expect(unpaired.reason).toBe("not-paired");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects Fix from a replication-only peer", () =>
    Effect.gen(function* () {
      const { channels, ran } = yield* harness();
      const error = yield* channels
        .dispatch({
          channel: MachineHealthFixRun.name,
          payload: { itemKeys: ["scheduled-tasks:nightly"] },
          caller: { environmentId: vps, scopes: [AuthSyncReplicateScope] },
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("forbidden");
      expect(ran).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an update fix for a caller without environment:maintain", () =>
    Effect.gen(function* () {
      const { fixes, ran } = yield* harness(true);
      const denied = yield* fixes.fix({ itemKeys: [`machine-version:${laptop}`] }, [
        AuthOrchestrationOperateScope,
      ]);
      expect(ran).toEqual([]);
      expect(denied.outcomes).toMatchObject([{ status: "failed" }]);
      const allowed = yield* fixes.fix({ itemKeys: [`machine-version:${laptop}`] }, [
        AuthOrchestrationOperateScope,
        AuthEnvironmentMaintainScope,
      ]);
      expect(allowed.outcomes).toMatchObject([{ status: "fixed" }]);
      expect(ran).toEqual(["update:0.3.4"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "checks forwarded caller scopes on the receiving machine, not the peer credential",
    () =>
      Effect.gen(function* () {
        const { channels, ran } = yield* harness(true);
        const denied = yield* channels.dispatch({
          channel: MachineHealthFixRun.name,
          payload: {
            itemKeys: [`machine-version:${laptop}`],
            callerScopes: [AuthOrchestrationOperateScope],
          },
          caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
        });
        expect(ran).toEqual([]);
        expect(denied).toMatchObject({ outcomes: [{ status: "failed" }] });
      }).pipe(Effect.scoped),
  );

  it.effect("serves a paired machine's Fix from this machine's own report", () =>
    Effect.gen(function* () {
      const { channels, ran } = yield* harness();
      const served = yield* channels.dispatch({
        channel: MachineHealthFixRun.name,
        payload: { itemKeys: ["scheduled-tasks:nightly"] },
        caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
      });
      expect(served).toMatchObject({
        environmentId: laptop,
        outcomes: [{ itemKey: "scheduled-tasks:nightly", status: "fixed" }],
      });
      expect(ran).toEqual([taskId]);
    }).pipe(Effect.scoped),
  );
});

describe("turning off a provider that isn't signed in", () => {
  const claude = ProviderInstanceId.make("claude");
  const signedOut: MachineHealthReport = {
    ...report,
    checks: [
      {
        id: "providers",
        status: "fail",
        summary: "",
        items: [
          item("providers:claude", "sign-in", { _tag: "provider", instanceId: claude }),
          ...report.checks[0]!.items,
        ],
      },
    ],
  };

  it.effect("turns it off in this machine's settings, with providers:manage", () =>
    Effect.gen(function* () {
      const { fixes, settings, peerCalls } = yield* harness(false, "boot-service", false, {
        report: signedOut,
      });
      const denied = yield* fixes.fix(
        { itemKeys: ["providers:claude"], action: "turn-off-provider" },
        [AuthOrchestrationOperateScope],
      );
      expect(denied.outcomes).toMatchObject([{ status: "failed" }]);
      expect((yield* settings.getSettings).providerInstances[claude]).toBeUndefined();

      const result = yield* fixes.fix(
        { itemKeys: ["providers:claude", "scheduled-tasks:nightly"], action: "turn-off-provider" },
        [AuthProvidersManageScope],
      );
      expect(result.outcomes).toMatchObject([
        {
          itemKey: "providers:claude",
          status: "fixed",
          message: expect.stringContaining("MacBook"),
        },
        // Turn off never runs another item's fix.
        { itemKey: "scheduled-tasks:nightly", status: "failed" },
      ]);
      expect((yield* settings.getSettings).providerInstances[claude]).toEqual({
        driver: "claude",
        enabled: false,
      });
      expect(peerCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("asks the machine with the problem over its own peer channel", () =>
    Effect.gen(function* () {
      const { fixes, settings, peerCalls } = yield* harness(false, "boot-service", false, {
        report: signedOut,
      });
      yield* fixes.fix(
        { environmentId: vps, itemKeys: ["providers:claude"], action: "turn-off-provider" },
        [AuthProvidersManageScope],
      );
      expect(peerCalls).toEqual([
        {
          environmentId: vps,
          channel: MachineHealthTurnOffProviderRun.name,
          payload: { itemKeys: ["providers:claude"], callerScopes: [AuthProvidersManageScope] },
        },
      ]);
      // Only that machine's settings change.
      expect((yield* settings.getSettings).providerInstances[claude]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("serves a paired machine's turn-off from this machine's own report", () =>
    Effect.gen(function* () {
      const { channels, settings } = yield* harness(false, "boot-service", false, {
        report: signedOut,
      });
      const served = yield* channels.dispatch({
        channel: MachineHealthTurnOffProviderRun.name,
        payload: { itemKeys: ["providers:claude"], callerScopes: [AuthProvidersManageScope] },
        caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
      });
      expect(served).toMatchObject({ outcomes: [{ status: "fixed" }] });
      expect((yield* settings.getSettings).providerInstances[claude]?.enabled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("summarizeFixOutcomes", () => {
  it("uses the item's own message when there is one item", () => {
    expect(
      summarizeFixOutcomes([{ itemKey: "a", status: "fixed", message: "Stopped 18 subagents." }]),
    ).toBe("Stopped 18 subagents.");
  });
});

it.effect("Fix starts this machine's staged update to match its newer peer", () =>
  Effect.gen(function* () {
    const { fixes, ran } = yield* harness(true);
    const result = yield* fixes.fix({ itemKeys: [`machine-version:${laptop}`] });
    expect(result.outcomes[0]).toMatchObject({
      status: "fixed",
      message: "Started updating to 0.3.4.",
    });
    expect(ran).toEqual(["update:0.3.4"]);
  }).pipe(Effect.scoped),
);

it.effect("peer update requests refuse an arbitrary version and require delegation rights", () =>
  Effect.gen(function* () {
    const { channels, ran } = yield* harness(true);
    for (const [targetVersion, scopes] of [
      ["9.9.9", [AuthPeerDelegateScope]],
      ["0.3.4", [AuthSyncReplicateScope]],
    ] as const) {
      yield* channels
        .dispatch({
          channel: MachineVersionUpdate.name,
          payload: { targetVersion },
          caller: { environmentId: vps, scopes },
        })
        .pipe(Effect.flip);
    }
    expect(ran).toEqual([]);
    yield* channels.dispatch({
      channel: MachineVersionUpdate.name,
      payload: { targetVersion: "0.3.4" },
      caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
    });
    expect(ran).toEqual(["update:0.3.4"]);
  }).pipe(Effect.scoped),
);

it.effect("leaves desktop updates to the app without starting a partial update", () =>
  Effect.gen(function* () {
    const { fixes, ran } = yield* harness(true, "desktop-managed");
    const result = yield* fixes.fix({ itemKeys: [`machine-version:${laptop}`] });
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(ran).toEqual([]);
  }).pipe(Effect.scoped),
);

describe("automatic fixes", () => {
  const machineTarget = (environmentId: EnvironmentId) =>
    ({ _tag: "machine", environmentId }) as const;
  const autoReport = (items: ReadonlyArray<MachineHealthItem>): MachineHealthReport => ({
    ...report,
    checks: [{ id: "sync", status: "fail", summary: "", items }],
  });

  it.effect("runs only the safe fixes, and holds their alerts", () =>
    Effect.gen(function* () {
      const h = yield* harness(false, "boot-service", false, {
        report: autoReport([
          item(`sync:stuck:${vps}`, "retry-sync", machineTarget(vps)),
          item(`machine-version:${vps}`, "update-machine", machineTarget(vps)),
          item(`machine-version:${laptop}`, "update-machine", machineTarget(laptop)),
          item("scheduled-tasks:nightly", "run-now", { _tag: "scheduledTask", taskId }),
          item("sync:quarantined-thread:thread:bad", "discard-quarantined", {
            _tag: "thread",
            threadId: ThreadId.make("thread:bad"),
          }),
          item("providers:claude", "sign-in", null),
        ]),
      });
      const outcomes = yield* h.fixes.autoFix;
      expect(outcomes.map((outcome) => [outcome.itemKey, outcome.status])).toEqual([
        [`sync:stuck:${vps}`, "failed"],
      ]);
      expect(h.retried).toEqual([vps]);
      expect(h.peerCalls).toEqual([]);
      expect(h.ran).toEqual([]);
      const view = yield* h.alertsState.autoFix;
      expect([...view.holds]).toEqual([]);
      expect(view.failures.has(`machine-version:${vps}`)).toBe(false);
      expect(view.failures.has(`machine-version:${laptop}`)).toBe(false);
      expect(view.failures.get(`sync:stuck:${vps}`)).toContain("still present");
      // The retry budget prevents another immediate attempt.
      expect(yield* h.fixes.autoFix).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("alerts with the reason when a fix fails, and retries it later", () =>
    Effect.gen(function* () {
      const key = `sync:stuck:${offline}`;
      const h = yield* harness(false, "boot-service", false, {
        report: autoReport([item(key, "retry-sync", machineTarget(offline))]),
      });
      expect(yield* h.fixes.autoFix).toMatchObject([{ itemKey: key, status: "failed" }]);
      const view = yield* h.alertsState.autoFix;
      expect(view.holds.has(key)).toBe(false);
      expect(view.failures.get(key)).toBe("Machine health could not be read.");
      expect(yield* h.fixes.autoFix).toEqual([]);
      yield* TestClock.adjust("30 minutes");
      expect(yield* h.fixes.autoFix).toMatchObject([{ itemKey: key, status: "failed" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing while the setting is off", () =>
    Effect.gen(function* () {
      const h = yield* harness(false, "boot-service", false, {
        enabled: false,
        report: autoReport([item(`sync:stuck:${vps}`, "retry-sync", machineTarget(vps))]),
      });
      expect(yield* h.fixes.autoFix).toEqual([]);
      expect(h.retried).toEqual([]);
      expect((yield* h.alertsState.autoFix).holds.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a successful retry when the recheck clears the problem", () =>
    Effect.gen(function* () {
      const check = {
        id: "sync" as const,
        status: "fail" as const,
        summary: "",
        items: [
          item("clears", "retry-sync", machineTarget(vps)),
        ] as ReadonlyArray<MachineHealthItem>,
      };
      const h = yield* harness(false, "boot-service", false, {
        report: { ...report, checks: [check] },
        afterRetry: () => {
          check.items = [];
        },
      });
      expect(yield* h.fixes.autoFix).toMatchObject([{ itemKey: "clears", status: "fixed" }]);
      expect((yield* h.alertsState.autoFix).failures.size).toBe(0);
      expect(yield* h.fixes.autoFix).toEqual([]);
      expect(h.retried).toEqual([vps]);
    }).pipe(Effect.scoped),
  );
});

it.effect("manual updates still start while work is running", () =>
  Effect.gen(function* () {
    const h = yield* harness(true, "boot-service", false, {
      report: {
        ...report,
        checks: [
          {
            id: "machine-links",
            status: "warn",
            summary: "Versions differ",
            items: [
              item(`machine-version:${laptop}`, "update-machine", {
                _tag: "machine",
                environmentId: laptop,
              }),
            ],
          },
        ],
      },
    });
    yield* h.sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES ('busy','work',1,'codex','running','2026-01-01','{}')`;
    expect(yield* h.fixes.autoFix).toEqual([]);
    expect(h.ran).toEqual([]);
    expect(h.peerCalls).toEqual([]);
    const view = yield* h.alertsState.autoFix;
    expect(view.holds.size).toBe(0);
    expect(view.failures.size).toBe(0);
    const result = yield* h.fixes.fix({ itemKeys: [`machine-version:${laptop}`] });
    expect(result.outcomes).toMatchObject([{ status: "fixed" }]);
    expect(h.ran).toEqual(["update:0.3.4"]);
    yield* h.channels.dispatch({
      channel: MachineVersionUpdate.name,
      payload: { targetVersion: "0.3.4" },
      caller: { environmentId: vps, scopes: [AuthPeerDelegateScope] },
    });
    expect(h.ran).toEqual(["update:0.3.4", "update:0.3.4"]);
  }).pipe(Effect.scoped),
);

it.effect("retained retry budgets do not hold recovered health items", () =>
  Effect.gen(function* () {
    const problem = item("recovered", "retry-sync", { _tag: "machine", environmentId: vps });
    const check: {
      id: "sync";
      status: "fail";
      summary: string;
      items: ReadonlyArray<MachineHealthItem>;
    } = { id: "sync", status: "fail", summary: "", items: [problem] };
    const h = yield* harness(false, "boot-service", false, {
      report: { ...report, checks: [check] },
    });
    yield* h.fixes.autoFix;
    expect((yield* h.alertsState.autoFix).failures.has(problem.key)).toBe(true);
    check.items = [{ ...problem, status: "ok", fix: null }];
    expect(yield* h.fixes.autoFix).toEqual([]);
    expect((yield* h.alertsState.autoFix).holds.size).toBe(0);
    const rows = yield* h.sql`SELECT item_key FROM health_auto_fix_attempts`;
    expect(rows).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("retry budgets survive service reconstruction and reset after a person's fix", () =>
  Effect.gen(function* () {
    const database = Sqlite.layerMemory;
    // Build once, then reconstruct the feature with the same durable database.
    const context = yield* Layer.build(database);
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(context));
    const options = {
      database: Layer.succeed(SqlClient.SqlClient, sql),
      report: {
        ...report,
        checks: [
          {
            id: "sync",
            status: "fail",
            summary: "",
            items: [item("persistent", "retry-sync", { _tag: "machine", environmentId: vps })],
          },
        ],
      } satisfies MachineHealthReport,
    };
    for (const delay of [0, 10, 20]) {
      yield* TestClock.adjust(`${delay} minutes`);
      const h = yield* harness(false, "boot-service", false, options);
      expect(yield* h.fixes.autoFix).toHaveLength(1);
    }
    yield* TestClock.adjust("1 day");
    const h = yield* harness(false, "boot-service", false, options);
    expect(yield* h.fixes.autoFix).toEqual([]);
    expect((yield* h.alertsState.autoFix).failures.has("persistent")).toBe(true);
    yield* h.fixes.fix({ itemKeys: ["persistent"] });
    expect(yield* h.fixes.autoFix).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("the live scheduler fires health-auto-fix and publishes to its shared alert state", () =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const retried = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const h = yield* harness(false, "boot-service", false, {
      scheduler: {
        register: (name, work) =>
          scheduler.register(
            name,
            work.pipe(
              Effect.ensuring(
                name === "health-auto-fix" ? Deferred.succeed(finished, undefined) : Effect.void,
              ),
            ),
          ),
      },
      retried,
      withAlerts: true,
      report: {
        ...report,
        checks: [
          {
            id: "sync",
            status: "fail",
            summary: "",
            items: [item("scheduled-auto", "retry-sync", { _tag: "machine", environmentId: vps })],
          },
        ],
      },
    });
    yield* Deferred.await(retried);
    yield* Deferred.await(finished);
    expect(h.retried).toEqual([vps]);
    expect((yield* h.alertsState.autoFix).failures.has("scheduled-auto")).toBe(true);
    yield* TestClock.adjust("3 minutes");
    expect(h.retried).toEqual([vps]);
    expect(Option.isSome(h.alerts)).toBe(true);
    if (Option.isSome(h.alerts))
      expect((yield* h.alerts.value.snapshot).open).toMatchObject([
        { itemKey: "scheduled-auto", status: "fail" },
      ]);
  }).pipe(Effect.provide(Scheduler.layer), Effect.scoped),
);
