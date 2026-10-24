import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineInfo, type MachineListResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as MachinesTurnContext from "../orchestration-v2/MachinesTurnContext.ts";
import * as Machines from "./Machines.ts";
import { layer, machinesTurnContext } from "./machinesTurnContext.ts";

const machine = (
  name: string,
  relation: MachineInfo["relation"],
  overrides: Partial<MachineInfo> = {},
): MachineInfo => ({
  environmentId: EnvironmentId.make(`env-${name.toLowerCase()}`),
  name,
  kind: relation === "this" ? "this-computer" : "other-computer",
  hardware: "laptop",
  platform: "darwin",
  providers: [],
  relation,
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
  ...overrides,
});

const header =
  'Paired machines (launch or delegate there with `machine: "<name>"` on thread_launch, create_threads, work_start, schedule_task or delegate_task):';

const spokeList: MachineListResult = {
  machines: [
    machine("MacBook", "this"),
    machine("vps-1", "hub", { hardware: "server", kind: "cloud-server" }),
  ],
  link: {
    _tag: "spoke",
    hubEnvironmentId: EnvironmentId.make("env-vps-1"),
    status: "online",
    route: null,
    lastError: null,
  },
};

describe("machinesTurnContext", () => {
  it("says nothing when this machine is the only one", () => {
    expect(
      machinesTurnContext({ machines: [machine("MacBook", "this")], link: { _tag: "standalone" } }),
    ).toBe("");
    // A hub whose only spoke revoked the pairing has no one to send work to.
    expect(
      machinesTurnContext({
        machines: [machine("vps-1", "this"), machine("MacBook", "spoke", { pairing: "revoked" })],
        link: { _tag: "hub", spokes: 1 },
      }),
    ).toBe("");
  });

  it("marks this machine and the hub from a spoke", () => {
    expect(machinesTurnContext(spokeList)).toBe(
      [
        "<machines>",
        header,
        "- MacBook (laptop, online) — this machine",
        "- vps-1 (server, online) — hub",
        "</machines>",
      ].join("\n"),
    );
  });

  it("marks this machine as the hub and notes offline spokes", () => {
    expect(
      machinesTurnContext({
        machines: [
          machine("vps-1", "this", { hardware: "server" }),
          machine("MacBook", "spoke"),
          machine("Studio\nMac", "spoke", { hardware: "desktop", online: false }),
        ],
        link: { _tag: "hub", spokes: 2 },
      }),
    ).toBe(
      [
        "<machines>",
        header,
        "- vps-1 (server, online) — this machine, hub",
        "- MacBook (laptop, online)",
        "- Studio Mac (desktop, offline)",
        "Offline machines can't take work until they reconnect.",
        "</machines>",
      ].join("\n"),
    );
  });
});

describe("machinesTurnContext layer", () => {
  it.effect("turns read the latest machine list once the link registers", () =>
    Effect.gen(function* () {
      const delivered = yield* Deferred.make<void>();
      const turns = yield* MachinesTurnContext.MachinesTurnContext;
      expect(yield* turns.read).toBe("");
      yield* Layer.build(
        layer.pipe(
          Layer.provide(
            Layer.mock(Machines.Machines)({
              // The next pull happens only after the first list is handled.
              subscribe: Stream.make(spokeList).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.succeed(delivered, undefined))),
                Stream.concat(Stream.never),
              ),
            }),
          ),
          Layer.provide(Layer.succeed(MachinesTurnContext.MachinesTurnContext, turns)),
        ),
      );
      yield* Deferred.await(delivered);
      expect(yield* turns.read).toBe(machinesTurnContext(spokeList));
    }).pipe(Effect.scoped, Effect.provide(MachinesTurnContext.layer)),
  );

  it.effect("a failing reader gives the turn nothing", () =>
    Effect.gen(function* () {
      const turns = yield* MachinesTurnContext.MachinesTurnContext;
      yield* turns.register(Effect.die("list unavailable"));
      expect(yield* turns.read).toBe("");
    }).pipe(Effect.scoped, Effect.provide(MachinesTurnContext.layer)),
  );
});
