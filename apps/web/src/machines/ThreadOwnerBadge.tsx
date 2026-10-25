import type { EnvironmentId } from "@cogenly/contracts";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  useEnvironmentMachines,
} from "../state/environments";
import { machineIconKind, threadOwnerMachine } from "./machines.logic";
import { useEnvironmentMachineList } from "./useMachines";

/**
 * "Runs on <machine>" beside the chat header's title: for a replica another
 * paired machine runs, and, while several machines are connected, for the
 * machine's own threads too, since the thread is listed once for all of them.
 */
export function ThreadOwnerBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly ownerMachine: EnvironmentId | null | undefined;
}) {
  const list = useEnvironmentMachineList(props.ownerMachine == null ? null : props.environmentId);
  const owner = threadOwnerMachine(list, props.ownerMachine);
  const severalConnected = useConnectedEnvironmentIds().length > 1;
  const environment = useEnvironment(props.environmentId);
  const machineKind = useEnvironmentMachines().get(props.environmentId) ?? "server";
  const runner =
    owner !== null
      ? {
          id: owner.environmentId,
          name: owner.name,
          kind: machineIconKind(owner),
          online: owner.online,
        }
      : props.ownerMachine == null && severalConnected && environment !== null
        ? { id: props.environmentId, name: environment.label, kind: machineKind, online: true }
        : null;
  if (runner === null) return null;
  return (
    // Keyed by owner: a move fades the new machine in place.
    <span key={runner.id} className="swap-motion ms-2 flex shrink-0 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger delay={300} render={<Badge variant="outline" size="sm" />}>
          <EnvironmentMachineIcon aria-hidden kind={runner.kind} />
          {/* The chip never shrinks into the title: a long machine name
              truncates, and narrow windows keep only the machine icon. */}
          <span className="max-w-40 truncate max-sm:sr-only">Runs on {runner.name}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {runner.online
            ? `${runner.name} runs this thread. What you send here goes to it.`
            : `${runner.name} runs this thread and is offline. It continues when that machine reconnects.`}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
