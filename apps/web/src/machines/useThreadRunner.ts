import type { EnvironmentId, EnvironmentMachineKind } from "@cogenly/contracts";

import { useEnvironment, useEnvironmentMachines } from "../state/environments";
import { machineIconKind, threadOwnerMachine } from "./machines.logic";
import { useEnvironmentMachineList } from "./useMachines";

/**
 * The machine that runs a thread, named as thread cards name it: the paired
 * machine that runs a replica, else the thread's own environment. Null until
 * the environment is known.
 */
export function useThreadRunner(
  environmentId: EnvironmentId,
  ownerMachine: EnvironmentId | null | undefined,
): {
  readonly name: string;
  readonly kind: EnvironmentMachineKind;
  readonly online: boolean;
} | null {
  const list = useEnvironmentMachineList(ownerMachine == null ? null : environmentId);
  const owner = threadOwnerMachine(list, ownerMachine);
  const environment = useEnvironment(environmentId);
  const machineKind = useEnvironmentMachines().get(environmentId) ?? "server";
  if (owner !== null) {
    return { name: owner.name, kind: machineIconKind(owner), online: owner.online };
  }
  return environment === null ? null : { name: environment.label, kind: machineKind, online: true };
}
