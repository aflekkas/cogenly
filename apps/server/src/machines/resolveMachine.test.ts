import { expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineInfo, type MachineListResult } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Machines from "./Machines.ts";
import { resolveMachine } from "./resolveMachine.ts";

const machine = (
  name: string,
  relation: MachineInfo["relation"],
  overrides: Partial<MachineInfo> = {},
): MachineInfo => ({
  environmentId: EnvironmentId.make(`machine:${name}`),
  name,
  relation,
  hardware: relation === "hub" ? "server" : "laptop",
  kind: relation === "hub" ? "cloud-server" : "this-computer",
  platform: "linux",
  providers: [],
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
  ...overrides,
});
const local = machine("Laptop", "this");
const hub = machine("Cloud", "hub", { online: false });
const withMachines = (machines: MachineListResult["machines"]) =>
  Layer.mock(Machines.Machines)({
    list: Effect.succeed({ machines, link: { _tag: "hub", spokes: machines.length - 1 } }),
  });

it.effect("omitted targets work without pairing, but explicit targets need a machine list", () =>
  Effect.gen(function* () {
    expect(yield* resolveMachine(undefined)).toBeUndefined();
    expect((yield* Effect.flip(resolveMachine("this"))).message).toContain("unavailable");
  }),
);

it.effect("resolves aliases, names and IDs without silently replacing an offline target", () =>
  Effect.gen(function* () {
    expect(yield* resolveMachine("this")).toBe(local.environmentId);
    for (const target of ["auto", "vps", "  cLoUd  ", hub.environmentId]) {
      expect(yield* resolveMachine(target)).toBe(hub.environmentId);
    }
  }).pipe(Effect.provide(withMachines([local, hub]))),
);

it.effect("refuses ambiguous or revoked destinations rather than guessing a machine", () =>
  Effect.gen(function* () {
    const second = machine("Other", "spoke", { hardware: "server" });
    const ambiguous = yield* Effect.flip(resolveMachine("vps")).pipe(
      Effect.provide(withMachines([local, hub, second])),
    );
    expect(ambiguous.message).toContain("More than one machine");
    expect(ambiguous.message).toContain("environment ID");
    const revoked = yield* Effect.flip(resolveMachine(hub.environmentId)).pipe(
      Effect.provide(withMachines([local, { ...hub, pairing: "revoked" }])),
    );
    expect(revoked.message).toContain("No paired machine");
  }),
);
