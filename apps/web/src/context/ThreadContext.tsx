import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useEnvironmentQuery } from "../state/query";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/**
 * The per-thread "Use project context" switch, for threads with confirmed projects.
 * Off keeps the thread's tags but stops retrieved context reaching the model.
 */
export function ProjectContextToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const settings = useEnvironmentQuery(
    agentWorkspaceRpc.contextSettings({ environmentId, input: { threadId } }),
  );
  const canEdit = useAtomValue(agentWorkspaceRpc.contextSetEnabled.permissionAtom(environmentId));
  const setEnabled = useOrchestrationCommand(agentWorkspaceRpc.contextSetEnabled, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? settings.data?.enabled ?? null;
  const change = async (next: boolean) => {
    setPending(next);
    const result = await setEnabled({ environmentId, input: { threadId, enabled: next } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change project context",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
    settings.refresh();
    setPending(null);
  };
  return (
    <div className="border-t border-border/70 px-3 py-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
        <span className="min-w-0 flex-1">Use project context</span>
        <Switch
          size="sm"
          checked={enabled ?? false}
          disabled={enabled === null || pending !== null || !canEdit}
          onCheckedChange={(next) => void change(next)}
        />
      </label>
      <p className="mt-1 text-2xs text-muted-foreground">
        {settings.error
          ? settings.error
          : "Only confirmed facts, open items and Work from these projects are sent to the model."}
      </p>
    </div>
  );
}
