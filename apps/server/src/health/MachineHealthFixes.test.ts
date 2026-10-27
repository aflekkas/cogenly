import { describe, expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthPeerDelegateScope,
  AuthSyncReplicateScope,
  EnvironmentId,
  MachineHealthFixRun,
  MachineVersionUpdate,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as MachineIdentity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as MachineHealth from "./MachineHealth.ts";
import * as MachineHealthFixes from "./MachineHealthFixes.ts";
import { summarizeFixOutcomes } from "./MachineHealthFixes.ts";

const laptop = EnvironmentId.make("laptop");
const vps = EnvironmentId.make("vps");
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
      MachineHealthFixes.layer.pipe(
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
                browserProblem
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
                    : { ...report, checks: [...report.checks, syncCheck] },
              ),
              discardQuarantined: (threadId) =>
                Effect.sync(() => {
                  ran.push(`discard:${threadId}`);
                  return 7;
                }),
              retrySync: ({ environmentId }) =>
                Effect.sync(() => {
                  retried.push(environmentId);
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
            Layer.mock(MachineIdentity.MachineIdentity)({ self: Effect.succeed(self) }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ScheduledTasks.ScheduledTaskService)({
              runNow: (input) =>
                Effect.sync(() => {
                  ran.push(input.id);
                  return {} as never;
                }),
            }),
            Layer.succeed(SqlClient.SqlClient, {} as never),
            NodeCrypto.layer,
          ),
        ),
      ),
    );
    const fixes = yield* MachineHealthFixes.MachineHealthFixes.pipe(Effect.provideContext(context));
    const channels = yield* PeerChannels.PeerChannels.pipe(Effect.provideContext(context));
    return { fixes, channels, ran, peerCalls, retried };
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
