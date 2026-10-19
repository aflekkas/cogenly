import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { deriveWorkStatus } from "@t3tools/client-runtime/state/work-status";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { BotIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { useAgentsIfProvided } from "~/agents/agentsClient";
import {
  useProjects,
  useServerConfigs,
  useThreadProjection,
  useThreadShell,
} from "~/state/entities";
import { classifySidebarThreadMode } from "../sidebar/modes/sidebarModes.logic";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { workStatusPresentation } from "./work.logic";

/**
 * Work provenance and status beside the thread title: where the session came
 * from (a chat or an agent, each a link back) and its derived run status.
 * Chats and agent conversations render nothing.
 */
export function WorkThreadHeaderMeta(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threadRef } = props;
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const scratchWorkspaceRoot = useServerConfigs().get(
    threadRef.environmentId,
  )?.scratchWorkspaceRoot;
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === threadRef.environmentId && candidate.id === thread?.projectId,
  );
  const agentRole = thread?.source.agent?.role;
  const isWork =
    thread !== null &&
    classifySidebarThreadMode({
      isAgentWork: agentRole === "work",
      isAgent: agentRole !== undefined,
      isScratch:
        project !== undefined &&
        (project.isScratch === true || isScratchProject(project, scratchWorkspaceRoot)),
    }) === "tasks";
  const projection = useThreadProjection(isWork ? threadRef : null);
  const status = useMemo(
    () => (projection ? workStatusPresentation(deriveWorkStatus(projection.projection)) : null),
    [projection],
  );
  const origin = thread?.source.workOrigin;
  const sourceThreadId = thread?.source.sourceThreadId ?? null;
  const sourceThreadRef = useMemo(
    () =>
      isWork && sourceThreadId !== null
        ? scopeThreadRef(threadRef.environmentId, sourceThreadId)
        : null,
    [isWork, sourceThreadId, threadRef.environmentId],
  );
  const sourceThread = useThreadShell(sourceThreadRef);
  const agents = useAgentsIfProvided();
  if (!isWork) return null;

  const sourceAgentId = thread.source.sourceAgentId;
  const agent =
    origin === "agent" && sourceAgentId !== undefined
      ? agents.find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId && candidate.id === sourceAgentId,
        )
      : undefined;
  // An agent's work links back to the conversation that asked for it.
  const backThreadId =
    origin === "agent" ? (sourceThreadId ?? agent?.conversationThreadId ?? null) : sourceThreadId;
  const originLabel =
    origin === "chat" && sourceThreadId !== null
      ? { prefix: "From chat", name: sourceThread?.title ?? null, Icon: MessageSquareIcon }
      : origin === "agent"
        ? { prefix: "Started by", name: agent?.name ?? "an agent", Icon: BotIcon }
        : null;

  if (originLabel === null && status === null) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-2 text-xs">
      {originLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={backThreadId === null}
                onClick={() => {
                  if (backThreadId !== null) props.onOpenThread(backThreadId);
                }}
                className="inline-flex min-w-0 max-w-56 cursor-pointer items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground"
              />
            }
          >
            <originLabel.Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {originLabel.prefix}
              {originLabel.name ? `: ${originLabel.name}` : null}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {backThreadId === null
              ? `${originLabel.prefix} ${originLabel.name ?? ""}`.trim()
              : origin === "agent"
                ? "Open the agent conversation"
                : "Open the chat this Work came from"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {status ? (
        <Badge variant={status.tone} size="sm" role="status">
          {status.label}
        </Badge>
      ) : null}
    </div>
  );
}
