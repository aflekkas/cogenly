import { useNavigate } from "@tanstack/react-router";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { projectPanelSummary } from "../../projects/projectPanel.logic";
import { useProjectFolderMenu } from "../../projects/useProjectFolderMenu";
import { ProjectLabelEditorDialog } from "../../../projectLabels/ProjectLabelEditorDialog";
import { ProjectSourceLinksDialog } from "../../../projectLabels/ProjectSourceLinks";
import type {
  EnvironmentProjectLabel,
  ProjectLabelKey,
} from "../../../projectLabels/projectLabels.logic";
import { ProjectFolderIcon } from "../../../projectLabels/ProjectFolderMark";
import { useProjectContents } from "../../../projectLabels/useProjectContents";
import { OverlayPresence } from "../../ui/overlay-presence";
import {
  SidebarList,
  SidebarRowSubtitle,
  sidebarRowClassName,
  sidebarRowIntrinsicSizeClassName,
} from "../SidebarList";
import { SidebarListEmptyState } from "../SidebarListEmptyState";

/**
 * One project in the list, at a Chats row's density: the folder and name,
 * then a muted line of what it holds. Right-click (or the context-menu key)
 * opens its menu; the row reads as selected while that menu is up.
 */
function ProjectRow(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly active: boolean;
  readonly chats: number;
  readonly work: number;
  readonly environmentLabel: string | null;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onLinkSources: () => void;
  readonly onDeleted: () => void;
}) {
  const { entry } = props;
  const { label } = entry;
  const menu = useProjectFolderMenu(entry, props);
  const summary = projectPanelSummary({
    repositories: label.repositoryIds.length,
    chats: props.chats,
    work: props.work,
    files: 0,
  });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      menu.openMenuAtElement(event.currentTarget);
    }
  };
  return (
    <li className={cn("list-none [content-visibility:auto]", sidebarRowIntrinsicSizeClassName(2))}>
      <button
        type="button"
        aria-current={props.active ? "page" : undefined}
        aria-label={[label.name, summary ?? "Empty"].join(", ")}
        onClick={props.onOpen}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          void menu.openMenu({ x: event.clientX, y: event.clientY });
        }}
        className={sidebarRowClassName({
          selected: props.active || menu.menuOpen,
          lines: 2,
          className: menu.menuOpen && "focus-visible:ring-0",
        })}
      >
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <ProjectFolderIcon color={label.color} className="size-4" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                props.active ? "text-foreground" : "text-foreground/80",
              )}
            >
              {label.name}
            </span>
          </span>
          <SidebarRowSubtitle>
            <span className="min-w-0 flex-1 truncate tabular-nums">{summary ?? "Empty"}</span>
            {props.environmentLabel ? (
              <span className="max-w-1/3 shrink-0 truncate">{props.environmentLabel}</span>
            ) : null}
          </SidebarRowSubtitle>
        </span>
      </button>
    </li>
  );
}

/**
 * The Projects mode list: every project folder across connected machines,
 * with what each holds. A folder opens its chat hero in the main area and
 * its detail in the right panel.
 */
export function SidebarProjectsList(props: {
  activeProjectKey: ProjectLabelKey | null;
  environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
  onOpenProject: (entry: EnvironmentProjectLabel) => void;
  onCreateProject: () => void;
}) {
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const [renaming, setRenaming] = useState<EnvironmentProjectLabel | null>(null);
  const [linking, setLinking] = useState<EnvironmentProjectLabel | null>(null);
  const leaveIfActive = (entry: EnvironmentProjectLabel) => {
    if (entry.key === props.activeProjectKey) void navigate({ to: "/project", replace: true });
  };
  if (directory.labels.length === 0) {
    return (
      <SidebarListEmptyState
        label="No projects yet"
        action={{ label: "New project", onClick: props.onCreateProject }}
      />
    );
  }
  return (
    <>
      <SidebarList aria-label="Projects" grow>
        {directory.labels.map((entry) => (
          <ProjectRow
            key={entry.key}
            entry={entry}
            active={entry.key === props.activeProjectKey}
            chats={byProject.get(entry.key)?.chats.length ?? 0}
            work={byProject.get(entry.key)?.work.length ?? 0}
            environmentLabel={props.environmentLabel(entry)}
            onOpen={() => props.onOpenProject(entry)}
            onRename={() => setRenaming(entry)}
            onLinkSources={() => setLinking(entry)}
            onDeleted={() => leaveIfActive(entry)}
          />
        ))}
      </SidebarList>
      <OverlayPresence when={renaming}>
        {(entry) => (
          <ProjectLabelEditorDialog
            environmentId={entry.environmentId}
            label={entry.label}
            onClose={() => setRenaming(null)}
            onDeleted={() => leaveIfActive(entry)}
          />
        )}
      </OverlayPresence>
      <OverlayPresence when={linking}>
        {(entry) => (
          <ProjectSourceLinksDialog
            environmentId={entry.environmentId}
            label={entry.label}
            onClose={() => setLinking(null)}
          />
        )}
      </OverlayPresence>
    </>
  );
}
