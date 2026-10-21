import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, FolderIcon, HammerIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { AgentFace } from "~/components/agents/face";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_CHEVRON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { agentsRpc } from "~/rpc/agents";
import { DetailRow } from "./AgentDetails";
import { AgentProjectPicker, useAgentProjectFolders } from "./AgentProjectPicker";
import { AgentResponsibilities } from "./AgentResponsibilities";
import type { AgentDetailsSection } from "./agentViewIntent";
import { agentStatusLabel, modelDisplayName } from "./agents.logic";
import { useAgents, useAgentsClient } from "./agentsClient";
import type { AgentContact, AgentWorkspaceView } from "./agents.types";

/**
 * Everything about an agent that isn't its conversation, as a compact popover from
 * the Details icon (the name pill at the top opens it too), laid out like a thread's
 * details: the face, name, status and model, its project and Start Work as rows, then dense sections
 * that edit in place. All of it can also be changed by telling the agent in chat.
 */
export function AgentDetailsMenu({
  agent,
  workspace,
  open,
  section,
  onOpenChange,
  onOpenChat,
  onStartWork,
  onDeleted,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  open: boolean;
  /** The section to land on when opened by request. */
  section: AgentDetailsSection;
  onOpenChange: (open: boolean) => void;
  onOpenChat: (messageId?: string) => void;
  onStartWork: () => void;
  onDeleted?: (() => void) | undefined;
}) {
  const client = useAgentsClient();
  const { models } = useAgents();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label="Agent details"
                  data-pressed={open ? "" : undefined}
                  className="shrink-0 [-webkit-app-region:no-drag]"
                />
              }
            />
          }
        >
          <SlidersHorizontalIcon className="size-4.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Agent details</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" collisionPadding={8} width="lg" padding="none">
        <div className="flex max-h-(--available-height) flex-col overflow-y-auto">
          <ThreadDetailsSection headingId="agent-details-heading" title="Agent" separated={false}>
            <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-1.5">
              <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={32} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {agentStatusLabel(agent)} · {modelDisplayName(models, agent.modelSelection)}
                </span>
              </span>
            </div>
            <AgentProjectRow agent={agent} />
            <DetailRow
              icon={HammerIcon}
              label="Start Work…"
              disabled={!canWrite}
              onClick={() => {
                onOpenChange(false);
                onStartWork();
              }}
            />
          </ThreadDetailsSection>
          <AgentResponsibilities
            key={open ? section : "closed"}
            agent={agent}
            workspace={workspace}
            section={section}
            onOpenChat={(messageId) => {
              onOpenChange(false);
              onOpenChat(messageId);
            }}
            onDeleted={() => {
              onOpenChange(false);
              onDeleted?.();
            }}
          />
          <p className="border-t border-border/65 px-4 py-2.5 text-xs text-muted-foreground">
            Everything here can also be changed by telling {agent.name} in its chat.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The project the agent's conversation is filed in, with a picker to move it to
 * another or to none. Hidden where there are no projects to pick from.
 */
function AgentProjectRow({ agent }: { agent: AgentContact }) {
  const client = useAgentsClient();
  const canMove = useAtomValue(agentsRpc.setProject.permissionAtom(agent.environmentId));
  const { folders, current } = useAgentProjectFolders(agent.environmentId, agent.projectFolderId);
  const [pending, setPending] = useState(false);
  if (folders.length === 0 && current === null) return null;
  const move = async (projectFolderId: typeof agent.projectFolderId) => {
    setPending(true);
    try {
      await client.setProject(agent, projectFolderId);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not move the agent",
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <AgentProjectPicker
      environmentId={agent.environmentId}
      value={current?.label.id ?? null}
      onChange={(projectFolderId) => void move(projectFolderId)}
      disabled={!canMove || pending}
      aria-label={
        current ? `Project: ${current.label.name}. Move to another` : "No project. Move to one"
      }
      trigger={
        <DetailRow
          icon={FolderIcon}
          label={
            <>
              Project
              {/* The detail row's value line, fading in place when the project changes. */}
              <span key={current?.key ?? "none"} className="swap-motion text-muted-foreground">
                {" "}
                · {current?.label.name ?? "None"}
              </span>
            </>
          }
          trailing={<ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />}
        />
      }
    />
  );
}
