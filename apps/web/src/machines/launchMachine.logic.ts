import type { EnvironmentId, MachineListResult } from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { machineMoveTargets } from "./machines.logic";

/**
 * The "Run on" choices for a draft: the connected environments that hold its
 * project, then the draft environment's paired machines that are not among
 * them, each once. A connected environment wins over the same machine reached
 * through pairing, so picking it keeps launching against that environment.
 * `pickedMachine` (the draft's pick, or the machine running the thread) stays
 * listed even when the pairing list has not arrived or no longer has it, so a
 * pick is never silently replaced.
 */
export function mergeRunOnOptions(input: {
  readonly environments: ReadonlyArray<EnvironmentOption>;
  readonly machines: MachineListResult | null;
  readonly pickedMachine: EnvironmentId | null;
}): ReadonlyArray<EnvironmentOption> {
  const listed = new Set(input.environments.map((option) => option.environmentId));
  const paired: EnvironmentOption[] = [];
  for (const target of machineMoveTargets(input.machines)) {
    if (listed.has(target.environmentId)) continue;
    listed.add(target.environmentId);
    paired.push({
      environmentId: target.environmentId,
      projectId: null,
      label: target.name,
      isPrimary: false,
      machine: target.icon,
      pairedMachine: { online: target.online },
    });
  }
  if (input.pickedMachine !== null && !listed.has(input.pickedMachine)) {
    paired.push({
      environmentId: input.pickedMachine,
      projectId: null,
      label: "Paired machine",
      isPrimary: false,
      machine: "server",
      pairedMachine: { online: false },
    });
  }
  return paired.length === 0 ? input.environments : [...input.environments, ...paired];
}

/** What picking a "Run on" choice does to the draft. */
export type RunOnPick =
  /** Move the draft to this connected environment, as before machines paired. */
  | { readonly kind: "environment"; readonly option: EnvironmentOption }
  /** Keep the draft where it is and launch it on this paired machine. */
  | { readonly kind: "machine"; readonly environmentId: EnvironmentId };

export function resolveRunOnPick(
  options: ReadonlyArray<EnvironmentOption>,
  environmentId: EnvironmentId,
): RunOnPick | null {
  const option = options.find((candidate) => candidate.environmentId === environmentId);
  if (option === undefined) return null;
  return option.pairedMachine === undefined
    ? { kind: "environment", option }
    : { kind: "machine", environmentId };
}

/**
 * Where a draft launches. The launch RPC always goes to the draft's own
 * environment; `machine` names the paired machine that runs it.
 *
 * Without a pick it runs on the draft environment. That is the machine with
 * the selected project's checkout: a draft's project is a checkout on its
 * environment, and picking a repository moves the draft to the connected
 * environment that has it. Paired machines' checkouts are unknown to the
 * client, so they are never a default; the server resolves or clones the
 * repository on one the user picks.
 */
export function resolveDraftLaunchTarget(input: {
  readonly draftEnvironmentId: EnvironmentId;
  readonly launchMachine: EnvironmentId | null | undefined;
}): { readonly environmentId: EnvironmentId; readonly machine?: EnvironmentId } {
  const machine = input.launchMachine ?? null;
  return machine === null || machine === input.draftEnvironmentId
    ? { environmentId: input.draftEnvironmentId }
    : { environmentId: input.draftEnvironmentId, machine };
}

/** The toast for a launch an offline machine refused; its action runs it on the draft environment. */
export function describeOfflineLaunch(input: {
  readonly machineName: string;
  readonly hereName: string;
}): { readonly title: string; readonly description: string; readonly actionLabel: string } {
  return {
    title: `${input.machineName} is offline`,
    description: "Nothing was started or queued. Your draft is unchanged.",
    actionLabel: `Run on ${input.hereName}`,
  };
}
