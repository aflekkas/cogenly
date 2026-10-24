import type { EnvironmentId } from "@cogenly/contracts";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { machineIconKind, threadOwnerMachine } from "./machines.logic";
import { useEnvironmentMachineList } from "./useMachines";

/**
 * "Runs on <machine>" beside the chat header's title, for a replica another
 * paired machine runs. This machine's own threads show nothing.
 */
export function ThreadOwnerBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly ownerMachine: EnvironmentId | null | undefined;
}) {
  const list = useEnvironmentMachineList(props.ownerMachine == null ? null : props.environmentId);
  const owner = threadOwnerMachine(list, props.ownerMachine);
  if (owner === null) return null;
  return (
    // Keyed by owner: a move fades the new machine in place.
    <span
      key={owner.environmentId}
      className="swap-motion ms-2 flex shrink-0 [-webkit-app-region:no-drag]"
    >
      <Tooltip>
        <TooltipTrigger delay={300} render={<Badge variant="outline" size="sm" />}>
          <EnvironmentMachineIcon aria-hidden kind={machineIconKind(owner)} />
          Runs on {owner.name}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {owner.online
            ? `${owner.name} runs this thread. What you send here goes to it.`
            : `${owner.name} runs this thread and is offline. It continues when that machine reconnects.`}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
