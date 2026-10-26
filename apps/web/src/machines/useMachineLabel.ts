import type { EnvironmentId, EnvironmentMachineKind } from "@cogenly/contracts";

import { useEnvironment, useEnvironmentMachines } from "../state/environments";
import { machineIconKind, threadOwnerMachine } from "./machines.logic";
import { useEnvironmentMachineList } from "./useMachines";

export interface MachineLabel {
  readonly name: string;
  readonly kind: EnvironmentMachineKind;
}

/**
 * The name and icon of `machineId`, for a "runs on" badge. A machine this client connects
 * to names itself; another is looked up in the machine list of `via`, the environment the
 * thread was read from. Null for no machine, or one neither knows.
 */
export function useMachineLabel(
  machineId: EnvironmentId | null,
  via: EnvironmentId | null,
): MachineLabel | null {
  const connected = useEnvironment(machineId);
  const machineKinds = useEnvironmentMachines();
  const list = useEnvironmentMachineList(machineId !== null && connected === null ? via : null);
  if (machineId === null) return null;
  if (connected !== null) {
    return { name: connected.label, kind: machineKinds.get(machineId) ?? "server" };
  }
  const paired = threadOwnerMachine(list, machineId);
  return paired === null ? null : { name: paired.name, kind: machineIconKind(paired) };
}
