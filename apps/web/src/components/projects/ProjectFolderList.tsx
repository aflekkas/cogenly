import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useDeleteProjectFolder } from "../../projectLabels/ProjectLabelEditorDialog";
import { projectFolderSummary } from "../../projectLabels/projectContents.logic";
import {
  PROJECT_LABEL_COLORS,
  type EnvironmentProjectLabel,
} from "../../projectLabels/projectLabels.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RepositoryBadge } from "../sidebar/modes/RepositoryBadge";
import { gridNeighbor } from "./projectGrid.logic";

type FolderMenuId = "open" | "rename" | "recolor" | `color:${string}` | "link-github" | "delete";

const MAX_BADGES = 4;

function FolderRow(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly repositoryNames: ReadonlyArray<string>;
  readonly environmentLabel: string | null;
  readonly activityLabel: string | null;
  readonly tabIndex: number;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onLinkSources: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onFocus: () => void;
}) {
  const { entry } = props;
  const { environmentId, label } = entry;
  const canUpdate = useAtomValue(
    serverEnvironment.updateProjectLabel.permissionAtom(environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteProjectLabel.permissionAtom(environmentId),
  );
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, {
    label: "recolor project",
    reportFailure: false,
  });
  const deleteFolder = useDeleteProjectFolder();
  // The row reads as selected while its menu is up, like a sidebar row.
  const [menuOpen, setMenuOpen] = useState(false);
  const summary = projectFolderSummary(label.repositoryIds.length, label.threadCount);
  const extraBadges = props.repositoryNames.length - MAX_BADGES;

  const openMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ReadonlyArray<ContextMenuItem<FolderMenuId>> = [
      { id: "open", label: "Open", icon: "folder" },
      { id: "rename", label: "Rename…", icon: "pencil", disabled: !canUpdate },
      {
        id: "recolor",
        label: "Color",
        disabled: !canUpdate,
        children: PROJECT_LABEL_COLORS.map((color) => ({
          id: `color:${color.value}` as const,
          label: color.label,
          checked: (label.color ?? "gray") === color.value,
        })),
      },
      { id: "link-github", label: "Link GitHub…", icon: "link", disabled: !canUpdate },
      {
        id: "delete",
        label: "Delete…",
        icon: "trash",
        destructive: true,
        disabled: !canDelete,
        separatorBefore: true,
      },
    ];
    setMenuOpen(true);
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    setMenuOpen(false);
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const id = clicked.value;
    if (id === "open") props.onOpen();
    else if (id === "rename") props.onRename();
    else if (id === "link-github") props.onLinkSources();
    else if (id === "delete") await deleteFolder(environmentId, label);
    else if (id.startsWith("color:")) {
      const result = await updateLabel({
        environmentId,
        input: { id: label.id, color: id.slice("color:".length) },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not recolor ${label.name}`, result);
      }
    }
  };
  const openMenuAtElement = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    void openMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={props.tabIndex}
        aria-label={[label.name, summary ?? "Empty"].join(", ")}
        className={cn(
          "group/project relative flex h-13 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left outline-none select-none transition-colors duration-(--motion-duration-base) ease-standard focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
          menuOpen ? "state-selected" : "state-hover",
        )}
        onClick={props.onOpen}
        onFocus={props.onFocus}
        onContextMenu={(event: ReactMouseEvent) => {
          event.preventDefault();
          void openMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpen();
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openMenuAtElement(event.currentTarget);
          } else {
            props.onKeyDown(event);
          }
        }}
      >
        <ProjectColorDot color={label.color} className="size-3" />
        <span className="min-w-0 truncate text-card font-medium text-foreground">{label.name}</span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground max-sm:hidden">
          {summary ?? "Empty"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {props.repositoryNames.length > 0 ? (
            <span className="flex items-center gap-1" aria-hidden>
              {props.repositoryNames.slice(0, MAX_BADGES).map((name) => (
                <RepositoryBadge key={name} name={name} />
              ))}
              {extraBadges > 0 ? (
                <span className="text-2xs tabular-nums text-muted-foreground">+{extraBadges}</span>
              ) : null}
            </span>
          ) : null}
          {props.environmentLabel ? (
            <span className="max-w-32 truncate text-sm text-secondary-label">
              {props.environmentLabel}
            </span>
          ) : null}
          {props.activityLabel ? (
            <span className="text-sm tabular-nums text-muted-foreground">
              {props.activityLabel}
            </span>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Actions for ${label.name}`}
            className={cn(
              "flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-opacity duration-(--motion-duration-base) ease-standard state-hover group-hover/project:opacity-100 group-focus-visible/project:opacity-100 motion-reduce:transition-none",
              menuOpen ? "opacity-100" : "opacity-0",
            )}
            onClick={(event) => {
              event.stopPropagation();
              openMenuAtElement(event.currentTarget);
            }}
          >
            <MoreHorizontalIcon className="size-4" />
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * Folders as compact rows: color, name, what each holds, its repositories,
 * and its latest activity. Arrow keys move between rows, Enter opens one, and
 * the context-menu key (or Shift+F10) opens its menu: Open, Rename, Color,
 * Link GitHub, Delete.
 */
export function ProjectFolderList(props: {
  readonly folders: ReadonlyArray<EnvironmentProjectLabel>;
  readonly environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
  readonly activityLabel: (entry: EnvironmentProjectLabel) => string | null;
  readonly onOpen: (entry: EnvironmentProjectLabel) => void;
  readonly onRename: (entry: EnvironmentProjectLabel) => void;
  readonly onLinkSources: (entry: EnvironmentProjectLabel) => void;
}) {
  const projects = useProjects();
  const count = props.folders.length;
  // Roving focus: one row is in the tab order, the one last focused.
  const [activeIndex, setActiveIndex] = useState(0);
  const tabIndexOf = (index: number) => (index === Math.min(activeIndex, count - 1) ? 0 : -1);
  const repositoryNames = (entry: EnvironmentProjectLabel) =>
    entry.label.repositoryIds.flatMap((repositoryId) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === entry.environmentId && candidate.id === repositoryId,
      );
      return project ? [project.title] : [];
    });
  const moveFocus = (index: number, event: ReactKeyboardEvent<HTMLElement>) => {
    const next = gridNeighbor(index, event.key, count, 1);
    if (next === null) return;
    event.preventDefault();
    const rows = event.currentTarget
      .closest("ul")
      ?.querySelectorAll<HTMLElement>('[role="button"]');
    rows?.[next]?.focus();
  };

  return (
    <ul aria-label="Projects" className="flex flex-col gap-px">
      {props.folders.map((entry, index) => (
        <FolderRow
          key={entry.key}
          entry={entry}
          repositoryNames={repositoryNames(entry)}
          environmentLabel={props.environmentLabel(entry)}
          activityLabel={props.activityLabel(entry)}
          tabIndex={tabIndexOf(index)}
          onFocus={() => setActiveIndex(index)}
          onOpen={() => props.onOpen(entry)}
          onRename={() => props.onRename(entry)}
          onLinkSources={() => props.onLinkSources(entry)}
          onKeyDown={(event) => moveFocus(index, event)}
        />
      ))}
    </ul>
  );
}
