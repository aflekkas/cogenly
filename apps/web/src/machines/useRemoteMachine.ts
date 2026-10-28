import type { EnvironmentId } from "@cogenly/contracts";
import { useMemo } from "react";

import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { isLocalMachine, resolveRemoteMachine, type RemoteMachine } from "./machineBadge.logic";
import { useEnvironmentMachineList } from "./useMachines";

/**
 * The cloud badge for work that runs on `runsOn`, or null when it runs on this
 * computer. `via` is the environment the work was read from, whose paired
 * machine list reports machines this client is not connected to right now.
 */
export function useRemoteMachine(
  runsOn: EnvironmentId | null,
  via: EnvironmentId | null,
): RemoteMachine | null {
  const localEnvironmentId = usePrimaryEnvironmentId();
  const remote = runsOn !== null && !isLocalMachine(runsOn, localEnvironmentId);
  const environment = useEnvironment(remote ? runsOn : null);
  const directName = environment?.label ?? null;
  const directPhase = environment?.connection.phase ?? null;
  const list = useEnvironmentMachineList(remote && directPhase !== "connected" ? via : null);
  const paired = list?.machines.find((machine) => machine.environmentId === runsOn) ?? null;
  const pairedName = paired?.name ?? null;
  const pairedOnline = paired?.online ?? true;
  return useMemo(
    () =>
      resolveRemoteMachine({
        runsOn,
        localEnvironmentId,
        direct:
          directName === null || directPhase === null
            ? null
            : { name: directName, phase: directPhase },
        paired: pairedName === null ? null : { name: pairedName, online: pairedOnline },
      }),
    [runsOn, localEnvironmentId, directName, directPhase, pairedName, pairedOnline],
  );
}
