import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { useAgents } from "../../../agents/agentsClient";
import { latestProjectActivity, projectPanelSummary } from "../../projects/projectPanel.logic";
import { useProjectFolderMenu } from "../../projects/useProjectFolderMenu";
import { ProjectLabelEditorDialog } from "../../../projectLabels/ProjectLabelEditorDialog";
import { ProjectSourceLinksDialog } from "../../../projectLabels/ProjectSourceLinks";
import {
  projectLabelKey,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "../../../projectLabels/projectLabels.logic";
import { ProjectFolderIcon } from "../../../projectLabels/ProjectFolderMark";
import { useProjectContents } from "../../../projectLabels/useProjectContents";
import { useProjectLabelDirectory } from "../../../projectLabels/useProjectLabels";
import { useConnectedEnvironmentIds } from "../../../state/environments";
import { formatRelativeTime } from "../../../timestampFormat";
import { OverlayPresence } from "../../ui/overlay-presence";
import { SIDEBAR_CARD_CLASS_NAME, SidebarList } from "../SidebarList";
import { SidebarListEmptyState } from "../SidebarListEmptyState";
import { SidebarSegmentBar } from "../SidebarShelfBar";
import { useSegmentSelection } from "../sidebarSegments.logic";
import { chatActivityAt } from "./sidebarModes.logic";
import { SIDEBAR_MODE_ICONS } from "./SidebarModeSwitcher";
import {
  PROJECT_LIST_FILTER_ORDER,
  setProjectListFilter,
  useProjectListFilter,
} from "./projectListFilter";

/**
 * The Projects filter the list shows: the one chosen, unless it holds
 * nothing, when it falls back to the other (see `useSegmentSelection`). The
 * list and its count bar both read it, so neither opens onto an empty filter.
 */
function useShownProjectListFilter() {
  const directory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  const requested = useProjectListFilter();
  const index = useSegmentSelection(
    [directory.active.length, directory.archived.length],
    PROJECT_LIST_FILTER_ORDER.indexOf(requested),
    (fallback) => setProjectListFilter(PROJECT_LIST_FILTER_ORDER[fallback] ?? "active"),
  );
  return {
    filter: PROJECT_LIST_FILTER_ORDER[index] ?? "active",
    active: directory.active.length,
    archived: directory.archived.length,
  };
}

/** The Projects column's count bar: active projects, then archived ones. */
export function ProjectsShelfBar() {
  const { filter, active, archived } = useShownProjectListFilter();
  return (
    <SidebarSegmentBar
      ariaLabel="Project lists"
      segments={[
        {
          icon: SIDEBAR_MODE_ICONS.projects,
          label: "Active projects",
          count: active,
          emptyLabel: "No active projects",
        },
        {
          icon: ArchiveIcon,
          label: "Archived",
          count: archived,
          emptyLabel: "Nothing archived",
        },
      ]}
      selectedIndex={PROJECT_LIST_FILTER_ORDER.indexOf(filter)}
      onSelect={(index) => setProjectListFilter(PROJECT_LIST_FILTER_ORDER[index] ?? "active")}
    />
  );
}

/**
 * One project in the list, as a card the size of a Work card: its folder and
 * name with the last activity, what it holds, then its description. Right-click
 * (or the context-menu key) opens its menu; the card reads as selected while
 * that menu is up.
 */
function ProjectCardRow(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly active: boolean;
  readonly chats: number;
  readonly work: number;
  readonly agents: number;
  readonly lastActivityAt: string | null;
  readonly environmentLabel: string | null;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onLinkSources: () => void;
  readonly onDeleted: () => void;
}) {
  const { entry } = props;
  const { label } = entry;
  const menu = useProjectFolderMenu(entry, props);
  const selected = props.active || menu.menuOpen;
  const summary =
    projectPanelSummary({
      repositories: label.repositoryIds.length,
      chats: props.chats,
      work: props.work,
      files: 0,
      agents: props.agents,
    }) ?? "Empty";
  const since = props.lastActivityAt ? formatRelativeTime(props.lastActivityAt) : null;
  const detail = [label.description?.trim() || null, props.environmentLabel]
    .filter(Boolean)
    .join(" · ");
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      menu.openMenuAtElement(event.currentTarget);
    }
  };
  return (
    <li className="list-none py-1 [content-visibility:auto] [contain-intrinsic-size:auto_5rem]">
      <button
        type="button"
        aria-current={props.active ? "page" : undefined}
        aria-label={[label.name, summary].join(", ")}
        data-testid="sidebar-project-card"
        onClick={props.onOpen}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          void menu.openMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          SIDEBAR_CARD_CLASS_NAME,
          "block",
          selected ? "state-selected" : "state-hover bg-(--sidebar-card) text-sidebar-foreground",
          menu.menuOpen && "focus-visible:ring-0",
        )}
      >
        <span className="relative z-10 flex h-[4.5rem] flex-col px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <ProjectFolderIcon color={label.color} className="size-4" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-card font-medium transition-colors duration-(--motion-duration-base) motion-reduce:transition-none",
                selected ? "text-foreground" : "text-foreground/85",
              )}
            >
              {label.name}
            </span>
            {since ? (
              <span className="shrink-0 text-xs tabular-nums text-secondary-label">
                {since.value}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex h-4 min-w-0 items-center text-xs text-muted-foreground transition-colors duration-(--motion-duration-base) group-[.state-selected]/sidebar-row:text-secondary-label motion-reduce:transition-none">
            <span className="min-w-0 flex-1 truncate tabular-nums">{summary}</span>
          </span>
          <span className="mt-1 flex h-4 min-w-0 items-center text-xs text-foreground/30 transition-colors duration-(--motion-duration-base) group-[.state-selected]/sidebar-row:text-foreground/45 motion-reduce:transition-none">
            <span className="min-w-0 flex-1 truncate">{detail}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The Projects mode list: every project folder across connected machines, as
 * cards, filtered to the active or the archived ones by the count bar
 * (`ProjectsShelfBar`). A project opens its page, with its one project
 * conversation, in the main area.
 */
export function SidebarProjectsList(props: {
  activeProjectKey: ProjectLabelKey | null;
  environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
  onOpenProject: (entry: EnvironmentProjectLabel) => void;
  onCreateProject: () => void;
}) {
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const { filter } = useShownProjectListFilter();
  const { agents } = useAgents();
  const agentsByProject = useMemo(() => {
    const counts = new Map<ProjectLabelKey, number>();
    for (const agent of agents) {
      if (!agent.projectFolderId) continue;
      const key = projectLabelKey(agent.environmentId, agent.projectFolderId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [agents]);
  const [renaming, setRenaming] = useState<EnvironmentProjectLabel | null>(null);
  const [linking, setLinking] = useState<EnvironmentProjectLabel | null>(null);
  const leaveIfActive = (entry: EnvironmentProjectLabel) => {
    if (entry.key === props.activeProjectKey) void navigate({ to: "/project", replace: true });
  };
  const shown = filter === "archived" ? directory.archived : directory.active;
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
      <SidebarList
        key={filter}
        aria-label={filter === "archived" ? "Archived projects" : "Projects"}
        density="cards"
        className="reveal-motion"
        grow
      >
        {shown.map((entry) => {
          const contents = byProject.get(entry.key);
          return (
            <ProjectCardRow
              key={entry.key}
              entry={entry}
              active={entry.key === props.activeProjectKey}
              chats={contents?.chats.length ?? 0}
              work={contents?.work.length ?? 0}
              agents={agentsByProject.get(entry.key) ?? 0}
              lastActivityAt={latestProjectActivity(contents, chatActivityAt)}
              environmentLabel={props.environmentLabel(entry)}
              onOpen={() => props.onOpenProject(entry)}
              onRename={() => setRenaming(entry)}
              onLinkSources={() => setLinking(entry)}
              onDeleted={() => leaveIfActive(entry)}
            />
          );
        })}
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
