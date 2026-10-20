import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon, MoreHorizontalIcon } from "lucide-react";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useDeleteProjectFolder } from "../../projectLabels/ProjectLabelEditorDialog";
import { projectFolderSummary } from "../../projectLabels/projectContents.logic";
import {
  PROJECT_LABEL_COLORS,
  projectLabelColorValue,
  type EnvironmentProjectLabel,
} from "../../projectLabels/projectLabels.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RepositoryBadge } from "../sidebar/modes/RepositoryBadge";
import { gridColumnCount, gridNeighbor } from "./projectGrid.logic";

type FolderMenuId = "open" | "rename" | "recolor" | `color:${string}` | "delete";

const MAX_BADGES = 4;
const CARD_CLASS =
  "group/folder corner-glow relative flex min-h-36 flex-col rounded-xl border border-(--surface-edge,var(--border)) bg-card text-left shadow-(--surface-halo,none) outline-none transition-colors duration-(--motion-duration-base) ease-standard state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function FolderCard(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly repositoryNames: ReadonlyArray<string>;
  readonly environmentLabel: string | null;
  readonly tabIndex: number;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onFocus: () => void;
  readonly cellRef: (node: HTMLDivElement | null) => void;
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
      {
        id: "delete",
        label: "Delete…",
        icon: "trash",
        destructive: true,
        disabled: !canDelete,
        separatorBefore: true,
      },
    ];
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const id = clicked.value;
    if (id === "open") props.onOpen();
    else if (id === "rename") props.onRename();
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
    void openMenu({ x: rect.left + 12, y: rect.bottom - 8 });
  };

  return (
    <div
      ref={props.cellRef}
      role="gridcell"
      tabIndex={props.tabIndex}
      aria-label={[label.name, summary ?? "Empty"].join(", ")}
      className={CARD_CLASS}
      style={{ "--label": projectLabelColorValue(label.color) } as CSSProperties}
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
      <div className="flex items-start justify-between p-4 pb-2">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-lg text-(--label)"
          style={{ backgroundColor: "color-mix(in oklab, var(--label) 16%, transparent)" }}
        >
          <FolderIcon className="size-6" />
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Actions for ${label.name}`}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-base) state-hover group-hover/folder:opacity-100 group-focus-visible/folder:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            openMenuAtElement(event.currentTarget);
          }}
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 pb-4">
        <span className="truncate text-sm font-medium text-foreground">{label.name}</span>
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {[summary ?? "Empty", props.environmentLabel].filter(Boolean).join(" · ")}
        </span>
        {props.repositoryNames.length > 0 ? (
          <span className="mt-auto flex min-w-0 items-center gap-1 pt-2" aria-hidden>
            {props.repositoryNames.slice(0, MAX_BADGES).map((name) => (
              <RepositoryBadge key={name} name={name} />
            ))}
            {extraBadges > 0 ? (
              <span className="text-2xs tabular-nums text-muted-foreground">+{extraBadges}</span>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Folders as a grid of cards, with a New project tile at the end. Arrow keys
 * move between cards, Enter opens one, and the context-menu key (or
 * Shift+F10) opens its menu: Open, Rename, Color, Delete.
 */
export function ProjectFolderGrid(props: {
  readonly folders: ReadonlyArray<EnvironmentProjectLabel>;
  readonly environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
  readonly canCreate: boolean;
  readonly onOpen: (entry: EnvironmentProjectLabel) => void;
  readonly onRename: (entry: EnvironmentProjectLabel) => void;
  readonly onCreate: () => void;
}) {
  const projects = useProjects();
  const cellRefs = useRef<Array<HTMLElement | null>>([]);
  const count = props.folders.length + 1;
  // Roving focus: one cell is in the tab order, the one last focused.
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
    const tops = cellRefs.current
      .slice(0, count)
      .map((node) => node?.getBoundingClientRect().top ?? 0);
    const next = gridNeighbor(index, event.key, count, gridColumnCount(tops));
    if (next === null) return;
    event.preventDefault();
    cellRefs.current[next]?.focus();
  };

  return (
    <div
      role="grid"
      aria-label="Projects"
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
    >
      <div role="row" className="contents">
        {props.folders.map((entry, index) => (
          <FolderCard
            key={entry.key}
            entry={entry}
            repositoryNames={repositoryNames(entry)}
            environmentLabel={props.environmentLabel(entry)}
            tabIndex={tabIndexOf(index)}
            onFocus={() => setActiveIndex(index)}
            cellRef={(node) => {
              cellRefs.current[index] = node;
            }}
            onOpen={() => props.onOpen(entry)}
            onRename={() => props.onRename(entry)}
            onKeyDown={(event) => moveFocus(index, event)}
          />
        ))}
        <div role="gridcell" className="contents">
          <button
            ref={(node) => {
              cellRefs.current[props.folders.length] = node;
            }}
            type="button"
            tabIndex={tabIndexOf(props.folders.length)}
            onFocus={() => setActiveIndex(props.folders.length)}
            disabled={!props.canCreate}
            onClick={props.onCreate}
            onKeyDown={(event) => moveFocus(props.folders.length, event)}
            className={cn(
              "flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground outline-none transition-colors duration-(--motion-duration-base) state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <FolderPlusIcon className="size-5" />
            New project
          </button>
        </div>
      </div>
    </div>
  );
}
