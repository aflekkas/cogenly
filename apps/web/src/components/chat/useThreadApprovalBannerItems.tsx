import { useAtomValue } from "@effect/atom-react";
import type { AgentApproval, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { describeThreadApproval } from "~/agents/agentWorkspace.logic";
import { agentWorkspaceRpc } from "~/rpc/agents";
import { threadApprovals } from "~/rpc/threadApprovals";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_APPROVALS = Atom.make<ReadonlyArray<AgentApproval>>([]).pipe(
  Atom.withLabel("thread-approvals:none"),
);
const NO_PERMISSION = Atom.make(false).pipe(Atom.withLabel("thread-approvals:no-permission"));

/**
 * One composer card per owner approval this thread waits on (a vault fill, a
 * CLI token). Allowing grants this thread through the same decision path as an
 * agent's approvals; the card leaves through the stack's own fade once the
 * server's list drops it.
 */
export function useThreadApprovalBannerItems(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const approvals = useAtomValue(
    environmentId !== null && threadId !== null
      ? threadApprovals.forThreadAtom(environmentId, threadId)
      : NO_APPROVALS,
  );
  const canDecide = useAtomValue(
    environmentId !== null
      ? agentWorkspaceRpc.agentsApprove.permissionAtom(environmentId)
      : NO_PERMISSION,
  );
  const approve = useOrchestrationCommand(agentWorkspaceRpc.agentsApprove);
  const reject = useOrchestrationCommand(agentWorkspaceRpc.agentsReject);
  // In flight, then decided: a decided card stays hidden even if the list lags behind.
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(() => new Set());
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());

  return useMemo(() => {
    if (environmentId === null) return [];
    const decide = async (id: string, decision: "approve" | "reject") => {
      setDeciding((current) => new Set(current).add(id));
      const command = decision === "approve" ? approve : reject;
      const result = await command({ environmentId, input: { id } });
      setDeciding((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (result._tag === "Success") setDecided((current) => new Set(current).add(id));
    };
    return approvals.flatMap((approval): ComposerBannerStackItem[] => {
      const description = describeThreadApproval(approval);
      if (description === null || decided.has(approval.id)) return [];
      const disabled = !canDecide || deciding.has(approval.id);
      return [
        {
          id: `thread-approval:${approval.id}`,
          variant: "warning",
          priority: "urgent",
          icon: <KeyRoundIcon />,
          title: description.title,
          description: description.details.join(" "),
          actions: (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => void decide(approval.id, "reject")}
              >
                Deny
              </Button>
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => void decide(approval.id, "approve")}
              >
                Allow in this thread
              </Button>
            </>
          ),
        },
      ];
    });
  }, [approvals, approve, canDecide, decided, deciding, environmentId, reject]);
}
