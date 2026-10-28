import { scopedThreadKey, scopeThreadRef } from "@cogenly/client-runtime/environment";

import { FolderGit2Icon } from "lucide-react";
import { threadRunsOn } from "../machines/machineBadge.logic";
import { useRemoteMachine } from "../machines/useRemoteMachine";
import { MachineBadge } from "./MachineBadge";

import { useUiStateStore } from "../uiStateStore";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "./Sidebar.logic";

import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(ref)],
  );
  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });
  return status ? <ThreadStatusLabel status={status} /> : null;
}

/**
 * Non-interactive trailing status for a thread row in compact contexts like
 * the command palette: a cloud when another machine runs the thread.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const machine = useRemoteMachine(threadRunsOn(thread), thread.environmentId);
  return <MachineBadge placement="inline" machine={machine} />;
}
