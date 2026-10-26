import { describe, expect, it } from "@effect/vitest";
import {
  AuthPeerDelegateScope,
  AuthSyncReplicateScope,
  EnvironmentId,
  MachineHealthFixRun,
  type MachineHealthFixResult,
  type MachineHealthItem,
  type MachineHealthReport,
  type MachineInfo,
  type MachineSelfReport,
  type PeerChannel,
  ScheduledTaskId,
} from "@cogenly/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

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

const harness = Effect.gen(function* () {
  const ran: Array<string> = [];
  const peerCalls: Array<{ environmentId: EnvironmentId; channel: string; payload: unknown }> = [];
  const self: MachineSelfReport = {
    environmentId: laptop,
    name: "MacBook",
    role: "computer",
    hardware: "laptop",
    platform: "darwin",
    serverVersion: "0.3.2",
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
  });
  const context = yield* Layer.build(
    MachineHealthFixes.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(MachineHealth.MachineHealth)({ report: Effect.succeed(report) }),
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
  return { fixes, channels, ran, peerCalls };
});

describe("MachineHealthFixes", () => {
  it.effect("runs direct fixes here and hands the rest to an agent", () =>
    Effect.gen(function* () {
      const { fixes, ran, peerCalls } = yield* harness;
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
      const { fixes, ran, peerCalls } = yield* harness;
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
      const { channels, ran } = yield* harness;
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

  it.effect("serves a paired machine's Fix from this machine's own report", () =>
    Effect.gen(function* () {
      const { channels, ran } = yield* harness;
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
