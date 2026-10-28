import { useAtomValue } from "@effect/atom-react";
import { CommandId, type EnvironmentId, type OrchestrationV2TurnItem } from "@cogenly/contracts";
import { MinusIcon } from "lucide-react";
import { useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

/** Historical requests only become actionable again through an explicit reopen. */
export function SkippedInputRequest({ environmentId, item, local }: {
  readonly environmentId: EnvironmentId;
  readonly item: OrchestrationV2TurnItem;
  readonly local: boolean;
}) {
  const command = orchestrationEnvironment.v2.dispatchCommand;
  const canReopen = useAtomValue(command.permissionAtom(environmentId));
  const dispatch = useOrchestrationCommand(command);
  const [pending, setPending] = useState(false);
  return (
    <AnimatedHeight>
      <WorkLogRow
        icon={<MinusIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={`${item.title ?? "Input request"} · Skipped`}
        trailing={local ? (
          <Button size="xs" variant="ghost-muted" disabled={!canReopen || pending} onClick={() => {
            setPending(true);
            void dispatch({ environmentId, input: {
              type: "inline-request.update", commandId: CommandId.make(crypto.randomUUID()),
              threadId: item.threadId, turnItemId: item.id, action: "reopen",
            } }).finally(() => setPending(false));
          }}>Reopen</Button>
        ) : undefined}
      />
    </AnimatedHeight>
  );
}
