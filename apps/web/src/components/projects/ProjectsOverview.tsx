import { matchesSettingsListQuery } from "../settings/settingsList.logic";
import { ProjectFoldersSettings } from "../settings/ProjectFoldersSettings";
import { SettingsSection, SettingsSectionAction } from "../settings/settingsLayout";
import {
  SettingsList,
  SettingsListItem,
  SettingsListToolbar,
  SettingsListSearch,
  SettingsListFilter,
  SettingsListEmpty,
} from "../settings/SettingsList";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAgents } from "../../agents/agentsClient";
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
import { OverlayPresence } from "../ui/overlay-presence";
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
  /** The open project's machine and id: Settings → Projects shows its page instead of the list. */
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
 * One project on the list: its folder and name with the last activity, its
 * description, then what it holds on every machine and the machines that have
 * it. Clicking opens the project's page; right-click (or the context-menu
 * key) opens its menu.
 */
function ProjectTile(props: {
  readonly entry: EnvironmentProjectLabel;
  readonly summary: string;
  readonly lastActivityAt: string | null;
  readonly machinesLabel: string | null;
  /** Every project, for its menu's Merge with. */
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onLinkSources: () => void;
}) {
  const { label } = props.entry;
  const menu = useProjectFolderMenu(props.entry, { ...props, onDeleted: () => {} });
  const description = label.description?.trim() || null;
  // One meta line: the summary, machines and last activity. It sits under a
  // description, or takes the description's place when there is none.
  const details = [
    props.summary,
    props.machinesLabel,
    props.lastActivityAt ? formatRelativeTimeLabel(props.lastActivityAt) : null,
  ].filter((part) => part !== null && part.length > 0);
  const meta = details.length > 0 ? details.join(" · ") : undefined;
  return (
    <SettingsListItem
      onContextMenu={(event) => {
        event.preventDefault();
        void menu.openMenu({ x: event.clientX, y: event.clientY });
      }}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProjectFolderIcon project={props.entry} className="size-4 shrink-0" />
          {label.name}
        </span>
      }
      description={description ?? meta}
      status={description ? meta : undefined}
      control={
        <>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Actions for ${label.name}`}
            onClick={(event) => menu.openMenuAtElement(event.currentTarget)}
          >
            <MoreHorizontalIcon />
          </Button>
          <Button size="sm" variant="outline" onClick={props.onOpen}>
            Open
          </Button>
        </>
      }
    />
  );
}

/**
 * Settings → Projects: every project across connected machines as a list, the
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
  const [query, setQuery] = useState("");
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

  const shownFilter = filter;
  const shown = (shownFilter === "archived" ? directory.archived : directory.active).filter(
    (entry) => matchesSettingsListQuery(query, [entry.label.name, entry.label.description]),
  );
  const duplicates = useMemo(() => possibleDuplicateProjects(directory.labels), [directory]);

  return (
    <>
      <SettingsSection
        id="project-folders"
        title="Projects"
        footer="Optional. Group the repositories, chats and agents of a bigger effort; a single repository doesn't need one."
        headerAction={
          <SettingsSectionAction
            disabled={createEnvironmentId === null || !canCreate}
            onClick={createProject}
          >
            New project
          </SettingsSectionAction>
        }
      >
        <SettingsListToolbar>
          <SettingsListSearch label="Search projects" value={query} onValueChange={setQuery} />
          <SettingsListFilter
            label="Status"
            value={shownFilter}
            onValueChange={(value) => {
              if (value === "active" || value === "archived") setFilter(value);
            }}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
            ]}
          />
        </SettingsListToolbar>
        {duplicates.map((pair) => (
          <PossibleDuplicateNotice key={pair.key} pair={pair} />
        ))}
        {shown.length === 0 ? (
          <SettingsListEmpty
            icon={<FolderIcon />}
            label={
              query
                ? "No projects match this search."
                : shownFilter === "archived"
                  ? "Archive a project from its menu to tuck it away here."
                  : "A project groups the repositories, chats, Work and agents of a large effort."
            }
          />
        ) : (
          <SettingsList aria-label={shownFilter === "archived" ? "Archived projects" : "Projects"}>
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
                  projects={directory.labels}
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
          </SettingsList>
        )}
      </SettingsSection>
      <ProjectFoldersSettings />
      <ProjectOrphanFolders environmentId={props.environmentId} />
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
