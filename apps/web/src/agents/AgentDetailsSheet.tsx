import { HammerIcon } from "lucide-react";
import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { AgentResponsibilities } from "./AgentResponsibilities";
import type { AgentDetailsSection } from "./agentViewIntent";
import { agentStatusLabel, modelDisplayName } from "./agents.logic";
import { useAgents, useAgentsClient } from "./agentsClient";
import type { AgentContact, AgentWorkspaceView } from "./agents.types";

/**
 * Everything about an agent that isn't its conversation, in a calm side sheet: who it
 * is, what it owns, when it runs, what it may do, its open items, activity and memory.
 * Each section edits in place; all of it can also be changed by telling the agent in chat.
 */
export function AgentDetailsSheet({
  agent,
  workspace,
  section,
  onClose,
  onOpenChat,
  onStartWork,
  onDeleted,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  /** The section to land on; the rest stays where the owner left it. */
  section: AgentDetailsSection;
  onClose: () => void;
  onOpenChat: (messageId?: string) => void;
  onStartWork: () => void;
  onDeleted?: (() => void) | undefined;
}) {
  const client = useAgentsClient();
  const { models } = useAgents();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" aria-label={`${agent.name} details`}>
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={40} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <SheetTitle>{agent.name}</SheetTitle>
              <SheetDescription>
                {agentStatusLabel(agent)} · {modelDisplayName(models, agent.modelSelection)}
              </SheetDescription>
            </div>
          </div>
          <div className="mt-1">
            <Button size="xs" variant="outline" disabled={!canWrite} onClick={onStartWork}>
              <HammerIcon />
              Start Work…
            </Button>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <AgentResponsibilities
            agent={agent}
            workspace={workspace}
            section={section}
            onOpenChat={onOpenChat}
            onDeleted={() => {
              onClose();
              onDeleted?.();
            }}
          />
          <p className="px-4 pt-1 pb-5 text-xs text-muted-foreground">
            Everything here can also be changed by telling {agent.name} in its chat.
          </p>
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}
