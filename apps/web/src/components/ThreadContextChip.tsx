import { integrationSourceNotice } from "@cogenly/client-runtime/composerThreadItems";
import type {
  AgentContextRecord,
  EnvironmentId,
  IntegrationCatalogId,
  ProjectFolderContextRecord,
  ThreadContextRecord,
} from "@cogenly/contracts";
import { Link } from "@tanstack/react-router";
import { BotIcon, MessagesSquareIcon } from "lucide-react";

import { useAgents } from "~/agents/agentsClient";
import { IntegrationSourceIcon, useComposerSources } from "./chat/ComposerSourcesPicker";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import { useEnvironmentProjectLabels } from "~/projectLabels/useProjectLabels";
import { useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ContextChipShell } from "./contextChipParts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Inline chip for an attached thread, in the composer and in sent messages. Prefers the
 * live title so a renamed thread never shows a stale label, and opens the thread on click.
 */
export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const title = shell?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <MessagesSquareIcon />
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{shell ? "Open thread" : "Thread no longer available"}</TooltipPopup>
    </Tooltip>
  );
}

/** Inline chip for a mentioned agent. Shows its live name and opens its conversation. */
export function AgentContextChip(props: {
  record: Pick<AgentContextRecord, "environmentId" | "agentId" | "conversationThreadId" | "name">;
  copyMarkdown?: string;
}) {
  const { environmentId, conversationThreadId } = props.record;
  const agent = useAgents().agents.find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.id === props.record.agentId,
  );
  const name = agent?.name.trim() || props.record.name;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="agent"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: conversationThreadId }}
              />
            }
            aria-label={`Agent, ${name}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <BotIcon />
            <ContextChipLabel>{name}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{agent ? "Open agent" : "Agent no longer available"}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Inline chip for a source (a connected integration) the agent should use. Pass the
 * composer's environment to watch the account live: a source that needs sign-in, is
 * failing or was removed turns to a warning with the reason in its tooltip. Sent
 * messages pass null and show the snapshot.
 */
export function IntegrationContextChip(props: {
  record: { integrationId: string; label: string; icon: IntegrationCatalogId | null };
  environmentId: EnvironmentId | null;
  copyMarkdown?: string;
}) {
  const { all, isLoaded } = useComposerSources(props.environmentId, null);
  const live = all.find((source) => source.id === props.record.integrationId);
  const watching = props.environmentId !== null && isLoaded;
  const notice = !watching
    ? null
    : live === undefined
      ? { detail: "This source is no longer connected. Reconnect it in Settings → Integrations." }
      : integrationSourceNotice(live);
  return (
    <ContextChipShell
      kind="integration"
      {...(notice ? { state: "warning" as const } : {})}
      icon={<IntegrationSourceIcon icon={live?.icon ?? props.record.icon} />}
      label={props.record.label}
      aria-label={`Source, ${props.record.label}${notice ? `. ${notice.detail}` : ""}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={notice ? notice.detail : "The agent uses this account"}
    />
  );
}

/** Inline chip for a mentioned project folder. Shows its live name and opens the project. */
export function ProjectFolderContextChip(props: {
  record: Pick<ProjectFolderContextRecord, "environmentId" | "projectFolderId" | "name">;
  copyMarkdown?: string;
}) {
  const { environmentId, projectFolderId } = props.record;
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const label = labels.find((candidate) => candidate.id === projectFolderId);
  const name = label?.name.trim() || props.record.name;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="project-folder"
            render={
              <Link
                to="/project/$environmentId/$labelId"
                params={{ environmentId, labelId: projectFolderId }}
              />
            }
            aria-label={`Project folder, ${name}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            <ProjectFolderIcon project={label ? { environmentId, label } : null} />
            <ContextChipLabel>{name}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {label ? "Open project" : "Project no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
