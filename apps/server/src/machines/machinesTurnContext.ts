/**
 * Tells every agent turn which paired machines it can launch or delegate work
 * on. Turns read the last rendered block from memory, so a slow or failing
 * machine list never delays a turn; it only empties the block.
 */
import type { MachineInfo, MachineListResult } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as MachinesTurnContext from "../orchestration-v2/MachinesTurnContext.ts";
import * as Machines from "./Machines.ts";
import { normalizeMachineName } from "./machineName.ts";

const machineLine = (machine: MachineInfo, isHub: boolean) => {
  const roles = [
    ...(machine.relation === "this" ? ["this machine"] : []),
    ...(isHub ? ["hub"] : []),
  ];
  const name = normalizeMachineName(machine.name);
  const state = machine.online ? "online" : "offline";
  return `- ${name} (${machine.hardware}, ${state})${roles.length === 0 ? "" : ` — ${roles.join(", ")}`}`;
};

/** The `<machines>` block, or "" when this machine is the only one. */
export const machinesTurnContext = (result: MachineListResult): string => {
  // A machine whose pairing was revoked can never take work; leave it out.
  const machines = result.machines.filter((machine) => machine.pairing !== "revoked");
  if (result.link._tag === "standalone" || machines.length < 2) return "";
  const hubIsThis = result.link._tag === "hub";
  const lines = machines.map((machine) =>
    machineLine(machine, machine.relation === "hub" || (hubIsThis && machine.relation === "this")),
  );
  return [
    "<machines>",
    'Paired machines (launch or delegate there with `machine: "<name>"` on thread_launch, create_threads, work_start, schedule_task or delegate_task):',
    ...lines,
    ...(machines.some((machine) => !machine.online)
      ? ["Offline machines can't take work until they reconnect."]
      : []),
    "</machines>",
  ].join("\n");
};

/** Keeps the block current from the machine list and registers it for turns. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const machines = yield* Machines.Machines;
    const turns = yield* MachinesTurnContext.MachinesTurnContext;
    const latest = yield* Ref.make("");
    yield* machines.subscribe.pipe(
      Stream.runForEach((result) => Ref.set(latest, machinesTurnContext(result))),
      // A stale list could advertise a machine that is gone; say nothing instead.
      Effect.tapCause(() => Ref.set(latest, "")),
      Effect.retry(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
    yield* turns.register(Ref.get(latest));
  }),
);
