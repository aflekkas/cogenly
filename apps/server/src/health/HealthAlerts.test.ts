import { describe, expect, it } from "@effect/vitest";
import {
  AuthSyncReplicateScope,
  EnvironmentId,
  MachineHealthAlertsRead,
  type MachineHealthAlert,
  type MachineHealthAlertsSnapshot,
  type MachineHealthItem,
  type MachineHealthReport,
  type MachineInfo,
  type PeerChannel,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Integrations from "../integrations/Integrations.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HealthAlerts from "./HealthAlerts.ts";
import * as HealthAlertsState from "./HealthAlertsState.ts";
import * as MachineHealth from "./MachineHealth.ts";

const self = EnvironmentId.make("laptop");
const hub = EnvironmentId.make("hub");

const signedOut: MachineHealthItem = {
  key: "providers:claude",
  status: "fail",
  title: "Claude needs sign-in",
  detail: "Refresh failed: access_token=abc123secret",
  since: null,
  target: null,
  fix: "sign-in",
};

const machine = (
  environmentId: EnvironmentId,
  name: string,
  relation: MachineInfo["relation"],
  online: boolean,
  lastSeenAt: DateTime.Utc | null,
): MachineInfo => ({
  environmentId,
  name,
  kind: relation === "this" ? "this-computer" : "cloud-server",
  hardware: relation === "this" ? "laptop" : "server",
  platform: "linux",
  relation,
  online,
  lastSeenAt,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
  providers: [],
});

/** The world the stubs read; tests mutate it between rounds. */
interface World {
  items: ReadonlyArray<MachineHealthItem>;
  hub: MachineInfo | null;
  hubAlerts: MachineHealthAlertsSnapshot;
}

const hubOwnAlert: MachineHealthAlert = {
  id: "hub:disk:root:0",
  originEnvironmentId: hub,
  originMachineName: "Contabo VPS",
  itemKey: "disk:root",
  checkId: "disk",
  state: "open",
  status: "warn",
  title: "Disk almost full",
  detail: "",
  openedAt: DateTime.makeUnsafe(0),
  resolvedAt: null,
  target: null,
  fix: null,
};

const harness = Effect.gen(function* () {
  const world: World = { items: [], hub: null, hubAlerts: { open: [], recentlyResolved: [] } };
  const calls: Array<{
    readonly integration: string;
    readonly tool: string;
    readonly args: unknown;
  }> = [];
  const published: Array<MachineHealthAlertsSnapshot> = [];
  const jobs = new Map<string, Effect.Effect<void>>();

  const report = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      environmentId: self,
      machineName: "Laptop",
      status: world.items.length > 0 ? "fail" : "ok",
      observedAt: now,
      serverVersion: "0.0.0",
      uptimeSeconds: 1,
      reachable: true,
      checks: [
        { id: "providers", status: "ok", summary: "", items: world.items },
        // The machine-links check names the hub too; alerts take it from the list instead.
        {
          id: "machine-links",
          status: "ok",
          summary: "",
          items: [{ ...signedOut, key: `machine-links:reachable:${hub}`, title: "Duplicate" }],
        },
      ],
    } satisfies MachineHealthReport;
  });

  const call = ((environmentId: EnvironmentId, channel: PeerChannel) =>
    environmentId === hub && channel.name === MachineHealthAlertsRead.name
      ? Effect.succeed(world.hubAlerts)
      : Effect.die("unexpected peer call")) as unknown as Machines.Machines["Service"]["call"];

  const deps = Layer.mergeAll(
    Layer.mock(MachineHealth.MachineHealth)({ report }),
    Layer.mock(Machines.Machines)({
      list: Effect.sync(() => ({
        machines: [
          machine(self, "Laptop", "this", true, null),
          ...(world.hub === null ? [] : [world.hub]),
        ],
        link: { _tag: "standalone" as const },
      })),
      call,
    }),
    PeerChannels.layer,
    // Rounds run explicitly, under the test clock, instead of on scheduler ticks.
    Layer.succeed(Scheduler.Scheduler, {
      register: (name, job) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<Effect.Services<typeof job>>();
          jobs.set(name, job.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    }),
    Layer.mock(Integrations.Integrations)({
      listTools: (name) =>
        Effect.succeed({
          name,
          tools:
            name === "slack"
              ? [
                  {
                    name: "slack_send_message",
                    description: "",
                    inputSchema: { properties: { channel_id: {}, message: {} } },
                  },
                ]
              : [
                  {
                    name: "send_gmail_message",
                    description: "",
                    inputSchema: { properties: { to: {}, subject: {}, body: {} } },
                  },
                ],
        }),
      callTool: (integration, tool, args) =>
        Effect.sync(() => {
          calls.push({ integration, tool, args });
          return { content: [] };
        }),
    }),
    ServerSettings.layerTest({
      health: {
        alertChannels: {
          slack: { enabled: true, integration: "slack", userId: "U012ABCDEF" },
          email: { enabled: true, integration: "google-me", to: "me@example.com" },
        },
      },
    }),
    Layer.effect(
      HealthAlertsState.HealthAlertsState,
      Effect.gen(function* () {
        const state = yield* HealthAlertsState.HealthAlertsState;
        return {
          ...state,
          publish: (snapshot: MachineHealthAlertsSnapshot) =>
            Effect.sync(() => void published.push(snapshot)).pipe(
              Effect.andThen(state.publish(snapshot)),
            ),
        };
      }),
    ).pipe(Layer.provide(HealthAlertsState.layer)),
  );
  const context = yield* Layer.build(HealthAlerts.layer.pipe(Layer.provideMerge(deps)));
  const alerts = yield* HealthAlerts.HealthAlerts.pipe(Effect.provideContext(context));
  const channels = yield* PeerChannels.PeerChannels.pipe(Effect.provideContext(context));
  const job = jobs.get("health-alerts")!;
  /** Advance one evaluation interval and run the due round. */
  const minute = TestClock.adjust("60 seconds").pipe(Effect.andThen(job));
  const minutes = (count: number) =>
    Effect.forEach(Array.from({ length: count }), () => minute, { discard: true });
  const state = yield* HealthAlertsState.HealthAlertsState.pipe(Effect.provideContext(context));
  return { world, calls, published, alerts, channels, state, job, minute, minutes };
});

describe("HealthAlerts", () => {
  it.effect("stays quiet while a problem is fixed automatically, and alerts when that fails", () =>
    Effect.gen(function* () {
      const { world, published, alerts, state, job, minutes } = yield* harness;
      world.items = [signedOut];
      yield* state.setAutoFix({ holds: new Set([signedOut.key]), failures: new Map() });
      yield* job;
      yield* minutes(4);
      expect(published).toEqual([]);
      yield* state.setAutoFix({
        holds: new Set(),
        failures: new Map([[signedOut.key, "The machine update could not be started."]]),
      });
      yield* minutes(3);
      const [opened] = (yield* alerts.snapshot).open;
      expect(opened?.detail).toContain(
        "Automatic fix failed: The machine update could not be started.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("publishes and delivers once per transition, own alerts only", () =>
    Effect.gen(function* () {
      const { world, calls, published, alerts, minute, minutes, job } = yield* harness;
      world.items = [signedOut];
      yield* job;
      yield* minute;
      expect(published).toEqual([]);
      yield* minute;
      expect(published).toHaveLength(1);
      const [opened] = (yield* alerts.snapshot).open;
      expect(opened).toMatchObject({ originEnvironmentId: self, title: "Claude needs sign-in" });
      expect(calls.map((entry) => [entry.integration, entry.tool])).toEqual([
        ["slack", "slack_send_message"],
        ["google-me", "send_gmail_message"],
      ]);
      expect(calls[0]!.args).toMatchObject({ channel_id: "U012ABCDEF" });
      expect(calls[1]!.args).toMatchObject({ to: "me@example.com" });
      for (const entry of calls) {
        expect(JSON.stringify(entry.args)).not.toContain("abc123secret");
        expect(JSON.stringify(entry.args)).toContain("Claude needs sign-in");
      }

      // Throttled between rounds, and quiet while the problem stays open.
      yield* TestClock.adjust("5 seconds");
      yield* job;
      yield* minutes(5);
      expect(published).toHaveLength(1);
      expect(calls).toHaveLength(2);

      // The first ok round starts the resolve debounce; it resolves two minutes later.
      world.items = [];
      yield* minutes(2);
      expect(published).toHaveLength(1);
      yield* minute;
      expect(published).toHaveLength(2);
      expect(yield* alerts.snapshot).toMatchObject({
        open: [],
        recentlyResolved: [{ id: opened!.id, state: "resolved" }],
      });
      expect(calls).toHaveLength(4);
      expect(JSON.stringify(calls[2]!.args)).toContain("Resolved on Laptop");
      yield* minutes(3);
      expect(published).toHaveLength(2);
      expect(calls).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("alerts on an offline hub only once its item fails, then resolves", () =>
    Effect.gen(function* () {
      const { world, calls, published, alerts, channels, job, minute, minutes } = yield* harness;
      const offline = machine(hub, "Contabo VPS", "hub", false, yield* DateTime.now);
      world.hub = offline;
      yield* job;
      yield* minutes(9);
      expect((yield* alerts.snapshot).open).toEqual([]);
      yield* minute;
      const [unreachable] = (yield* alerts.snapshot).open;
      expect(unreachable).toMatchObject({
        originEnvironmentId: hub,
        itemKey: `machine-links:reachable:${hub}`,
        title: "Contabo VPS hasn't been reachable for 10 minutes",
        status: "fail",
      });
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls[0]!.args)).toContain("hasn't been reachable for 10 minutes");

      // Back online: its own alerts merge in, but are the hub's to deliver.
      world.hub = { ...offline, online: true, lastSeenAt: yield* DateTime.now };
      world.hubAlerts = {
        open: [
          hubOwnAlert,
          // The hub's view of this machine is not shown back to it.
          { ...hubOwnAlert, id: "laptop:x:0", originEnvironmentId: self },
        ],
        recentlyResolved: [],
      };
      yield* minute;
      expect((yield* alerts.snapshot).open.map((alert) => alert.id)).toEqual([
        unreachable!.id,
        hubOwnAlert.id,
      ]);
      expect(calls).toHaveLength(2);
      yield* minutes(2);
      const snapshot = yield* alerts.snapshot;
      expect(snapshot.open.map((alert) => alert.id)).toEqual([hubOwnAlert.id]);
      expect(snapshot.recentlyResolved.map((alert) => alert.id)).toEqual([unreachable!.id]);
      expect(calls).toHaveLength(4);
      expect(published).toHaveLength(3);

      // The peer channel serves this machine's own alerts, never merged ones.
      const served = yield* channels.dispatch({
        channel: MachineHealthAlertsRead.name,
        payload: {},
        caller: { environmentId: hub, scopes: [AuthSyncReplicateScope] },
      });
      expect(served).toMatchObject({ open: [], recentlyResolved: [{ id: unreachable!.id }] });
    }).pipe(Effect.scoped),
  );

  it.effect("tests each configured channel and reports failures per channel", () =>
    Effect.gen(function* () {
      const { alerts, calls } = yield* harness;
      expect(yield* alerts.testChannels).toEqual({
        slack: { attempted: true, ok: true, error: null },
        email: { attempted: true, ok: true, error: null },
      });
      expect(calls.map((entry) => JSON.stringify(entry.args))).toEqual([
        expect.stringContaining("Cogenly test alert from Laptop"),
        expect.stringContaining("Cogenly test alert from Laptop"),
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("subscribe starts with the current snapshot", () =>
    Effect.gen(function* () {
      const { alerts } = yield* harness;
      const first = yield* alerts.subscribe.pipe(Stream.take(1), Stream.runCollect);
      expect(Array.from(first)).toEqual([{ open: [], recentlyResolved: [] }]);
    }).pipe(Effect.scoped),
  );
});
