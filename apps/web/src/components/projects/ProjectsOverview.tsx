import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, LaptopMinimalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAgents } from "../../agents/agentsClient";
import { cn } from "../../lib/utils";
import { openCreateProjectDialog } from "../../projectLabels/CreateProjectDialogHost";
import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
import { ProjectLabelEditorDialog } from "../../projectLabels/ProjectLabelEditorDialog";
import { ProjectSourceLinksDialog } from "../../projectLabels/ProjectSourceLinks";
import {
  projectLabelEnvironmentIds,
  possibleDuplicateProjects,
  projectLabelKey,
  projectRepositoryCount,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "../../projectLabels/projectLabels.logic";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { chatActivityAt } from "../sidebar/modes/sidebarModes.logic";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { OverlayPresence } from "../ui/overlay-presence";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PageContent } from "../PageContent";
import { PossibleDuplicateNotice } from "./PossibleDuplicateNotice";
import { ProjectOrphanFolders } from "./ProjectOrphanFolders";
import {
  latestProjectActivity,
  projectMachinesLabel,
  projectPanelSummary,
} from "./projectPanel.logic";
import { useProjectFolderMenu } from "./useProjectFolderMenu";

export interface ProjectsOverviewSearch {
  readonly create?: true | undefined;
  /** The machine a new project is created on; defaults to the primary one. */
  readonly environmentId?: EnvironmentId | undefined;
  /** The open project's machine and id: Settings → Projects shows its page instead of the grid. */
  readonly projectEnvironmentId?: EnvironmentId | undefined;
  readonly projectLabelId?: ProjectLabelId | undefined;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function validateProjectsOverviewSearch(
  raw: Record<string, unknown>,
): ProjectsOverviewSearch {
  return {
    ...(raw.create === true || raw.create === "1" || raw.create === "true"
      ? { create: true as const }
      : {}),
    ...(nonEmptyString(raw.environmentId)
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(nonEmptyString(raw.projectEnvironmentId) && nonEmptyString(raw.projectLabelId)
      ? {
          projectEnvironmentId: raw.projectEnvironmentId as EnvironmentId,
          projectLabelId: raw.projectLabelId as ProjectLabelId,
        }
      : {}),
  };
}

/** Settings → Projects, or one project's page there. */
export const PROJECTS_SETTINGS_PATH = "/settings/project-tags";

export function projectSettingsSearch(environmentId: EnvironmentId, labelId: ProjectLabelId) {
  return { projectEnvironmentId: environmentId, projectLabelId: labelId };
}

type ProjectsFilter = "active" | "archived";

/**
 * One project on the grid: its folder and name with the last activity, its
 * description, then what it holds on every machine and the machines that have
 * it. Clicking opens the project's page; right-click (or the context-menu
 * key) opens its menu.
 */
function ProjectTile(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly summary: string;
  readonly lastActivityAt: string | null;
  readonly machinesLabel: string | null;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onLinkSources: () => void;
}) {
  const { label } = props.entry;
  const menu = useProjectFolderMenu(props.entry, { ...props, onDeleted: () => {} });
  const description = label.description?.trim() || null;
  return (
    <li className="flex min-w-0 list-none">
      <button
        type="button"
        data-menu-open={menu.menuOpen ? "" : undefined}
        aria-label={[label.name, props.summary, description].filter(Boolean).join(", ")}
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            menu.openMenuAtElement(event.currentTarget);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void menu.openMenu({ x: event.clientX, y: event.clientY });
        }}
        className="project-tile flex-1"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProjectFolderIcon project={props.entry} className="size-4.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {label.name}
          </span>
          {props.lastActivityAt ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(props.lastActivityAt)}
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="line-clamp-2 text-xs/relaxed text-muted-foreground">{description}</span>
        ) : null}
        {/* Counts and machines get a line each and wrap rather than truncate. */}
        <span className="mt-auto flex min-w-0 flex-col gap-0.5 pt-1 text-xs text-muted-foreground">
          <span className="min-w-0 break-words tabular-nums">{props.summary}</span>
          {props.machinesLabel ? (
            <span className="flex min-w-0 items-start gap-1">
              <LaptopMinimalIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{props.machinesLabel}</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * Settings → Projects: every project across connected machines as a grid, the
 * active ones or the archived ones. A project opens its page in the same
 * section. `?create` opens the new-project dialog at once.
 */
export function ProjectsOverview(props: ProjectsOverviewSearch) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createEnvironmentId = props.environmentId ?? primaryEnvironmentId;
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(createEnvironmentId),
  );
  const { directory, byProject } = useProjectContents();
  const { agents } = useAgents();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [filter, setFilter] = useState<ProjectsFilter>("active");
  // Only a filter the user picked fades the grid; opening the page shows it at once.
  const [filterPicked, setFilterPicked] = useState(false);
  const [renaming, setRenaming] = useState<EnvironmentProjectLabel | null>(null);
  const [linking, setLinking] = useState<EnvironmentProjectLabel | null>(null);

  const createProject = () => {
    if (createEnvironmentId !== null)
      openCreateProjectDialog({ environmentId: createEnvironmentId });
  };
  const openedCreate = useRef(false);
  useEffect(() => {
    if (!props.create || openedCreate.current || !canCreate || createEnvironmentId === null) return;
    openedCreate.current = true;
    openCreateProjectDialog({ environmentId: createEnvironmentId });
  }, [canCreate, createEnvironmentId, props.create]);

  const agentsByProject = useMemo(() => {
    const counts = new Map<ProjectLabelKey, number>();
    for (const agent of agents) {
      if (!agent.projectFolderId) continue;
      const key = directory.byKey.get(
        projectLabelKey(agent.environmentId, agent.projectFolderId),
      )?.key;
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [agents, directory]);
  // The machines only say something when there is more than one.
  const machinesLabel = (entry: EnvironmentProjectLabel) =>
    presentations.size > 1
      ? projectMachinesLabel(
          projectLabelEnvironmentIds(entry),
          (environmentId) => presentations.get(environmentId)?.entry.target.label ?? null,
        )
      : null;

  // An empty filter falls back to the other, so the page never opens onto nothing.
  const shownFilter: ProjectsFilter =
    filter === "archived" && directory.archived.length === 0 ? "active" : filter;
  const shown = shownFilter === "archived" ? directory.archived : directory.active;
  const duplicates = useMemo(() => possibleDuplicateProjects(directory.labels), [directory]);

  return (
    <>
      <div
        id="project-folders"
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      >
        <PageContent width="wide" className="pb-0">
          <div className="flex w-full min-w-0 items-center gap-3">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              Repositories, chats, Work, files and agents grouped by effort. Agents can change any
              project from a thread.
            </p>
            <span className="flex shrink-0 items-center gap-2">
              {directory.archived.length > 0 ? (
                <ToggleGroup
                  aria-label="Which projects"
                  variant="segmented"
                  value={[shownFilter]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "active" || value === "archived") {
                      setFilter(value);
                      setFilterPicked(true);
                    }
                  }}
                >
                  <Toggle value="active">Active</Toggle>
                  <Toggle value="archived">Archived · {directory.archived.length}</Toggle>
                </ToggleGroup>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={createEnvironmentId === null || !canCreate}
                onClick={createProject}
              >
                <FolderPlusIcon />
                New project
              </Button>
            </span>
          </div>
        </PageContent>

        {/* The tiles give keyboard access, so the viewport stays out of the tab order. */}
        <ScrollArea className="min-h-0 flex-1" viewportTabIndex={-1}>
          <PageContent width="wide">
            {duplicates.map((pair) => (
              <PossibleDuplicateNotice key={pair.key} pair={pair} />
            ))}
            {directory.labels.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia>
                    <FolderIcon />
                  </EmptyMedia>
                  <EmptyTitle>No projects yet</EmptyTitle>
                  <EmptyDescription>
                    A project groups the repositories, chats, Work, files and agents for one effort,
                    and gives agents its instructions.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={createEnvironmentId === null || !canCreate}
                    onClick={createProject}
                  >
                    <FolderPlusIcon />
                    New project
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <ul
                key={shownFilter}
                aria-label={shownFilter === "archived" ? "Archived projects" : "Projects"}
                className={cn(
                  filterPicked && "swap-motion",
                  "grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3",
                )}
              >
                {shown.map((entry) => {
                  const contents = byProject.get(entry.key);
                  return (
                    <ProjectTile
                      key={entry.key}
                      entry={entry}
                      summary={
                        projectPanelSummary({
                          // Every repository any machine links, once each.
                          repositories: projectRepositoryCount(entry),
                          chats: contents?.chats.length ?? 0,
                          work: contents?.work.length ?? 0,
                          files: 0,
                          agents: agentsByProject.get(entry.key) ?? 0,
                        }) ?? "Empty"
                      }
                      lastActivityAt={latestProjectActivity(contents, chatActivityAt)}
                      machinesLabel={machinesLabel(entry)}
                      onOpen={() =>
                        void navigate({
                          to: PROJECTS_SETTINGS_PATH,
                          search: projectSettingsSearch(entry.environmentId, entry.label.id),
                        })
                      }
                      onRename={() => setRenaming(entry)}
                      onLinkSources={() => setLinking(entry)}
                    />
                  );
                })}
              </ul>
            )}
          </PageContent>
          <ProjectOrphanFolders environmentId={props.environmentId} />
        </ScrollArea>
      </div>
      <OverlayPresence when={renaming}>
        {(entry) => (
          <ProjectLabelEditorDialog
            environmentId={entry.environmentId}
            label={entry.label}
            onClose={() => setRenaming(null)}
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
