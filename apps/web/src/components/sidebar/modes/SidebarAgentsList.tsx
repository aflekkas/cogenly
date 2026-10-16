/**
 * The Agents mode list: scheduled tasks grouped by project, each with a live
 * face. A row opens the agent's thread; a task that is not bound to a thread
 * opens its settings instead.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AgentFace } from "../../agents/face";
import type { AgentGroup, AgentRow, AgentStatusTone } from "./agentState.logic";
import { SidebarModeGroupLabel } from "./SidebarModeGroupLabel";

const TONE_CLASS: Record<AgentStatusTone, string> = {
  attention: "text-warning-foreground",
  working: "text-info",
  error: "text-error",
  success: "text-success",
  muted: "text-secondary-label",
};

export function SidebarAgentsList(props: {
  groups: ReadonlyArray<AgentGroup<EnvironmentThreadShell>>;
  /** `environmentId:threadId` of the open thread. */
  activeThreadKey: string | null;
  renderGroupIcon: (environmentId: EnvironmentId, projectId: ProjectId) => ReactNode;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onOpenTask: (environmentId: EnvironmentId, taskId: ScheduledTaskId) => void;
  onThreadContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onCreateAgent: () => void;
}) {
  if (props.groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <AgentFace seed="cogenly-empty-agents" state="asleep" size={40} />
        <p className="text-xs font-medium text-sidebar-foreground/80">No agents yet</p>
        <p className="max-w-56 text-2xs text-sidebar-muted-foreground">
          An agent is a thread that runs on a schedule and picks up where it left off.
        </p>
        <button
          type="button"
          onClick={props.onCreateAgent}
          className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <PlusIcon className="-mx-0.5 size-3" />
          Create an agent
        </button>
      </div>
    );
  }
  return (
    <ul role="presentation" className="flex flex-col gap-px" data-testid="sidebar-agents-list">
      {props.groups.map((group) => [
        <SidebarModeGroupLabel
          key={`label:${group.projectKey}`}
          icon={props.renderGroupIcon(group.environmentId, group.projectId)}
        >
          {group.label}
        </SidebarModeGroupLabel>,
        ...group.rows.map((row) => (
          <SidebarAgentRow
            key={row.key}
            row={row}
            isActive={
              row.thread !== null &&
              props.activeThreadKey === `${row.environmentId}:${row.thread.id}`
            }
            onOpenThread={props.onOpenThread}
            onOpenTask={props.onOpenTask}
            onThreadContextMenu={props.onThreadContextMenu}
          />
        )),
      ])}
    </ul>
  );
}

const SidebarAgentRow = memo(function SidebarAgentRow(props: {
  row: AgentRow<EnvironmentThreadShell>;
  isActive: boolean;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onOpenTask: (environmentId: EnvironmentId, taskId: ScheduledTaskId) => void;
  onThreadContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const { row } = props;
  const threadRef = row.thread ? scopeThreadRef(row.environmentId, row.thread.id) : null;
  const open = () => {
    if (threadRef) props.onOpenThread(threadRef);
    else props.onOpenTask(row.environmentId, row.task.id);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (!threadRef) return;
    event.preventDefault();
    props.onThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  return (
    <li className="list-none" data-agent-item={row.key}>
      <div
        role="button"
        tabIndex={0}
        aria-current={props.isActive ? "page" : undefined}
        aria-label={`${row.task.title}, ${row.presentation.statusText}`}
        data-testid="sidebar-agent-row"
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        }}
        onContextMenu={handleContextMenu}
        className={cn(
          "group/sidebar-row relative flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <AgentFace
          seed={row.task.id}
          state={row.presentation.state}
          size={32}
          className="shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-sm font-medium",
              row.presentation.state === "idle" || row.presentation.state === "asleep"
                ? "text-foreground/80"
                : "text-foreground",
            )}
          >
            {row.task.title}
          </span>
          <span className={cn("truncate text-xs tabular-nums", TONE_CLASS[row.presentation.tone])}>
            {row.presentation.statusText}
          </span>
        </span>
      </div>
    </li>
  );
});
