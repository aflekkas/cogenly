import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatThreadLink, percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";
import { Link, useNavigate } from "@tanstack/react-router";
import { ClockIcon, MessageSquareTextIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { useProject, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";

/**
 * A link to another thread in chat: a `cogenly-thread://` link, or a plain URL of one of the app's
 * thread pages. It shows the thread's current title, so a rename reaches every message that links
 * to it, and opens the thread in the app. Hovering previews its last activity, and its project
 * when it has a real one (a chat's scratch folder is not shown).
 * A thread this client cannot see renders `fallback`, or the label as plain text.
 */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly fallback?: ReactNode;
}) {
  const navigate = useNavigate();
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const thread = written ?? decoded;
  const project = useProject(
    thread === null ? null : scopeProjectRef(props.environmentId, thread.projectId),
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const shownProject =
    project !== null && !isScratchProject(project, serverConfig?.scratchWorkspaceRoot)
      ? project
      : null;
  if (thread === null) {
    return (
      props.fallback ?? (
        <span data-markdown-copy={formatThreadLink(props.threadId, props.label)}>
          {props.label}
        </span>
      )
    );
  }
  const params = { environmentId: props.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label;
  const lastActivity = formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/$environmentId/$threadId"
            params={params}
            className="link"
            data-markdown-copy={formatThreadLink(thread.id, title)}
            onClick={(event) => {
              // The desktop app has one window, so a modifier click opens the thread here too.
              // On the web the browser opens it in a new tab.
              if (!isElectron || !(event.metaKey || event.ctrlKey || event.shiftKey)) return;
              event.preventDefault();
              void navigate({ to: "/$environmentId/$threadId", params });
            }}
          >
            <span
              className="ms-[0.1em] me-[0.25em] inline-flex size-[14px] [vertical-align:-0.125em]"
              aria-hidden
            >
              <MessageSquareTextIcon className="block size-full shrink-0" />
            </span>
            {title}
          </Link>
        }
      />
      <ThreadHoverCardPopup side="top">
        <ThreadHoverCard title={title}>
          {shownProject ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon project={shownProject} className="size-3 shrink-0" />
              <div className="min-w-0 truncate text-foreground/75">{shownProject.title}</div>
            </div>
          ) : null}
          {lastActivity ? (
            <div className="flex min-w-0 items-center gap-2">
              <ClockIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                Last activity {lastActivity}
              </div>
            </div>
          ) : null}
        </ThreadHoverCard>
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
