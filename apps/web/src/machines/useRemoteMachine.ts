import type { EnvironmentId } from "@cogenly/contracts";
import { useMemo } from "react";

import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { isLocalMachine, resolveRemoteMachine, type RemoteMachine } from "./machineBadge.logic";
import { useEnvironmentMachineList } from "./useMachines";

const UNREACHABLE_PHASES = new Set(["offline", "error", "unsupported"]);

/**
 * The cloud badge for work that runs on `runsOn`, or null when it runs on this
 * computer. `via` is the environment the work was read from, whose paired
 * machine list names a machine this client does not connect to.
 */
export function useRemoteMachine(
  runsOn: EnvironmentId | null,
  via: EnvironmentId | null,
): RemoteMachine | null {
  const localEnvironmentId = usePrimaryEnvironmentId();
  const remote = runsOn !== null && !isLocalMachine(runsOn, localEnvironmentId);
  const environment = useEnvironment(remote ? runsOn : null);
  const list = useEnvironmentMachineList(remote && environment === null ? via : null);
  const paired = list?.machines.find((machine) => machine.environmentId === runsOn) ?? null;
  const connectedName = environment?.label ?? null;
  const connectedOnline =
    environment === null ? true : !UNREACHABLE_PHASES.has(environment.connection.phase);
  const pairedName = paired?.name ?? null;
  const pairedOnline = paired?.online ?? true;
  return useMemo(
    () =>
      resolveRemoteMachine({
        runsOn,
        localEnvironmentId,
        connected: connectedName === null ? null : { name: connectedName, online: connectedOnline },
        paired: pairedName === null ? null : { name: pairedName, online: pairedOnline },
      }),
    [runsOn, localEnvironmentId, connectedName, connectedOnline, pairedName, pairedOnline],
  );
}
