import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@cogenly/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronLeftIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PencilIcon,
  ServerIcon,
  Settings2Icon,
  SquarePenIcon,
  TrashIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { useScratchProject } from "../../hooks/useScratchProject";
import { machineMoveTargets, type MachineMoveTarget } from "../../machines/machines.logic";
import { useEnvironmentMachineList } from "../../machines/useMachines";
import { useMoveProjectToMachine } from "../../machines/useMoveToMachine";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  ProjectLabelEditorDialog,
  useDeleteProjectFolder,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
import { ProjectSourceLinksDialog } from "../../projectLabels/ProjectSourceLinks";
import {
  projectExtraSourceLinks,
  projectGitHubOrg,
} from "../../projectLabels/projectSourceLinks.logic";
import {
  possibleDuplicateProjects,
  PROJECT_LABEL_COLORS,
  projectMergeCandidates,
  projectLabelEnvironmentIds,
  projectLabelKey,
  projectLabelOn,
  projectLabelPaletteColor,
  type PossibleDuplicateProjects,
} from "../../projectLabels/projectLabels.logic";
import {
  useMergeDuplicateProjects,
  useProjectMergePermissions,
} from "../../projectLabels/useMergeDuplicateProjects";
import { linkedRepositoryRows } from "../../projectLabels/repositoryPicker.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjectArchive } from "../../projectLabels/useProjectArchive";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { getSidebarProjectSettingsKey } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { chatActivityAt } from "../sidebar/modes/sidebarModes.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { GitHubIcon } from "../Icons";
import { OverlayPresence } from "../ui/overlay-presence";
import { ScrollArea } from "../ui/scroll-area";
import { PageContent } from "../PageContent";
import {
  AgentsCard,
  FilesCard,
  RecentCard,
  RepositoriesCard,
  SourcesCard,
} from "./ProjectHomeCards";
import { PossibleDuplicateNotice } from "./PossibleDuplicateNotice";
import { sortRecentFirst } from "./projectPanel.logic";
import { PROJECTS_SETTINGS_PATH } from "./ProjectsOverview";
import { useProjectResources } from "./useProjectResources";

/**
 * The project's name as a heading that edits in place: click it (or pick
 * Rename) for a field; Enter or leaving it saves, Escape puts the name back.
 */
function ProjectNameEditor(props: {
  readonly name: string;
  readonly editing: boolean;
  readonly canEdit: boolean;
  readonly onStartEdit: () => void;
  readonly onSave: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.name);
  const commit = () => {
    const next = draft.trim();
    if (next.length === 0 || next === props.name) {
      props.onCancel();
      return;
    }
    void props.onSave(next);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(props.name);
      props.onCancel();
    }
  };
  if (props.editing) {
    return (
      <Input
        size="sm"
        aria-label="Project name"
        autoFocus
        value={draft}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <h1 className="min-w-0 truncate text-sm font-medium text-foreground">
      <button
        type="button"
        disabled={!props.canEdit}
        aria-label={`Rename ${props.name}`}
        className="max-w-full cursor-text truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
        onClick={() => {
          setDraft(props.name);
          props.onStartEdit();
        }}
      >
        {props.name}
      </button>
    </h1>
  );
}

/** "Move project to <machine>…", or a submenu of paired machines; nothing when standalone. */
function ProjectMachineMenuItems(props: {
  readonly targets: ReadonlyArray<MachineMoveTarget>;
  readonly canMove: boolean;
  readonly onMove: (target: MachineMoveTarget) => void;
}) {
  const [only] = props.targets;
  if (only === undefined) return null;
  const item = (target: MachineMoveTarget, label: string) => (
    <MenuItem
      key={target.environmentId}
      disabled={!props.canMove || !target.online}
      onClick={() => props.onMove(target)}
    >
      <EnvironmentMachineIcon aria-hidden kind={target.icon} />
      {target.online ? label : `${label} (offline)`}
    </MenuItem>
  );
  if (props.targets.length === 1) return item(only, `Move project to ${only.name}…`);
  return (
    <MenuSub>
      <MenuSubTrigger disabled={!props.canMove}>
        <ServerIcon />
        Move project to machine
      </MenuSubTrigger>
      <MenuSubPopup>{props.targets.map((target) => item(target, `${target.name}…`))}</MenuSubPopup>
    </MenuSub>
  );
}

/** "Merge with" and the other projects a machine has alongside this one. */
function ProjectMergeMenuItems(props: {
  readonly labelId: ProjectLabelId;
  readonly candidates: ReadonlyArray<PossibleDuplicateProjects>;
  readonly allowedMerges: ReadonlySet<string>;
  readonly onMerge: (pair: PossibleDuplicateProjects) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger disabled={props.allowedMerges.size === 0}>
        <CopyIcon />
        Merge with
      </MenuSubTrigger>
      <MenuSubPopup>
        {props.candidates.map((pair) => {
          const other = pair.into.label.id === props.labelId ? pair.from : pair.into;
          return (
            <MenuItem
              key={pair.key}
              disabled={!props.allowedMerges.has(pair.key)}
              onClick={() => props.onMerge(pair)}
            >
              <ProjectFolderIcon project={other} className="size-4" />
              {other.label.name}…
            </MenuItem>
          );
        })}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The header's ⋯ menu: a new chat in the project, rename, color, details, move, merge, archive, delete. */
function ProjectHeaderMenu(props: {
  readonly label: ProjectLabelWithRepositories;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly archived: boolean;
  readonly canArchive: boolean;
  readonly machineTargets: ReadonlyArray<MachineMoveTarget>;
  readonly canMoveToMachine: boolean;
  readonly mergeCandidates: ReadonlyArray<PossibleDuplicateProjects>;
  readonly allowedMerges: ReadonlySet<string>;
  readonly onMerge: (pair: PossibleDuplicateProjects) => void;
  readonly onNewChat: () => void;
  readonly onRename: () => void;
  readonly onRecolor: (color: string) => void;
  readonly onEditDetails: () => void;
  readonly onMoveToMachine: (target: MachineMoveTarget) => void;
  readonly onToggleArchived: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost-muted" aria-label="Project actions" />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={props.onNewChat}>
          <SquarePenIcon />
          New chat in project
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!props.canEdit} onClick={props.onRename}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!props.canEdit}>
            <PaletteIcon />
            Color
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={projectLabelPaletteColor(props.label.color)}
              onValueChange={(value) => {
                if (typeof value === "string") props.onRecolor(value);
              }}
            >
              {PROJECT_LABEL_COLORS.map((color) => (
                <MenuRadioItem key={color.value} value={color.value}>
                  <span className="flex items-center gap-2">
                    <ProjectFolderIcon color={color.value} className="size-4" />
                    {color.label}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuItem disabled={!props.canEdit} onClick={props.onEditDetails}>
          <Settings2Icon />
          Edit details…
        </MenuItem>
        <ProjectMachineMenuItems
          targets={props.machineTargets}
          canMove={props.canMoveToMachine}
          onMove={props.onMoveToMachine}
        />
        <ProjectMergeMenuItems
          labelId={props.label.id}
          candidates={props.mergeCandidates}
          allowedMerges={props.allowedMerges}
          onMerge={props.onMerge}
        />
        <MenuSeparator />
        <MenuItem disabled={!props.canArchive} onClick={props.onToggleArchived}>
          {props.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          {props.archived ? "Unarchive" : "Archive"}
        </MenuItem>
        <MenuItem variant="destructive" disabled={!props.canDelete} onClick={props.onDelete}>
          <TrashIcon />
          Delete…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** One card in the page's balanced columns: kept whole, with the column gap below it. */
function ProjectCardSlot(props: { readonly children: ReactNode }) {
  return <div className="mb-3 break-inside-avoid">{props.children}</div>;
}

/** Recent shows every chat and Work filed in the project. */
const NOTHING_EXCLUDED: ReadonlySet<string> = new Set();

/**
 * One project's page in Settings → Projects: a row with its name, GitHub org
 * and actions, then the cards it is built from (repositories, recent threads,
 * sources, files, agents) in balanced columns that scroll with the page.
 * Instructions, like everything else here, are something any thread's agent
 * sets with the project tools. Picking another project fades the new page in.
 */
export function ProjectView(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  return (
    <ProjectPage
      key={projectLabelKey(props.environmentId, props.labelId)}
      environmentId={props.environmentId}
      labelId={props.labelId}
    />
  );
}

function ProjectPage(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  const { environmentId, labelId } = props;
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const { isLoaded, error } = useEnvironmentProjectLabels(environmentId);
  // The project as one across connected machines; its page names any machine's copy.
  const entry = directory.byKey.get(projectLabelKey(environmentId, labelId)) ?? null;
  const label = entry?.label ?? null;
  const contents = entry === null ? undefined : byProject.get(entry.key);
  const { environments } = useEnvironments();
  const machineIds = entry === null ? [environmentId] : projectLabelEnvironmentIds(entry);
  const machineOptions = machineIds.map((id) => ({
    environmentId: id,
    label: environments.find((environment) => environment.environmentId === id)?.label ?? id,
  }));
  // Repositories and files are per machine: the page shows one machine's at a time.
  const [pickedMachine, setPickedMachine] = useState(environmentId);
  const machineId = machineIds.includes(pickedMachine)
    ? pickedMachine
    : (machineIds[0] ?? environmentId);
  const machineEntry = entry === null ? null : projectLabelOn(entry, machineId);
  const repositories = useEnvironmentRepositories(machineId);
  const files = useProjectResources(machineId, labelId);
  const canEdit = useAtomValue(serverEnvironment.updateProjectLabel.permissionAtom(environmentId));
  const canDelete = useAtomValue(
    serverEnvironment.deleteProjectLabel.permissionAtom(environmentId),
  );
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, {
    label: "update project",
    reportFailure: false,
  });
  const deleteFolder = useDeleteProjectFolder();
  const archive = useProjectArchive(environmentId, label);
  const machineList = useEnvironmentMachineList(environmentId);
  const machineTargets = machineMoveTargets(machineList, undefined, true);
  const canMoveToMachine = useAtomValue(
    serverEnvironment.moveProjectToMachine.permissionAtom(environmentId),
  );
  const moveProjectToMachine = useMoveProjectToMachine();
  const { startScratchThread } = useScratchProject();
  const [renaming, setRenaming] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const projects = useProjects();
  const projectGroups = useSidebarProjectGroups();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);

  // Every repository the project links, with its state on this machine:
  // the same list the repository pickers show.
  const repositoryRows = useMemo(
    () =>
      machineEntry === null
        ? []
        : linkedRepositoryRows({
            project: machineEntry,
            localById: new Map(repositories.map((repository) => [repository.id, repository])),
          }),
    [machineEntry, repositories],
  );
  const duplicates = useMemo(
    () =>
      entry === null
        ? []
        : possibleDuplicateProjects(directory.labels).filter(
            (pair) => pair.into.key === entry.key || pair.from.key === entry.key,
          ),
    [directory, entry],
  );
  const mergeCandidates = useMemo(
    () => (entry === null ? [] : projectMergeCandidates(entry, directory.labels)),
    [directory, entry],
  );
  const allowedMerges = useProjectMergePermissions(mergeCandidates);
  const { mergePair } = useMergeDuplicateProjects();
  const chats = useMemo(() => sortRecentFirst(contents?.chats ?? [], chatActivityAt), [contents]);
  const work = useMemo(() => sortRecentFirst(contents?.work ?? [], chatActivityAt), [contents]);
  const [editingSources, setEditingSources] = useState(false);

  const openRepositorySettings = (repositoryId: ProjectId) => {
    const group = projectGroups.find((candidate) =>
      candidate.memberProjectRefs.some(
        (ref) => ref.environmentId === machineId && ref.projectId === repositoryId,
      ),
    );
    if (!group) return;
    void navigate({
      to: "/projects/$projectKey",
      params: {
        projectKey: getSidebarProjectSettingsKey(group, groupingSettings, projects, {
          environmentId: machineId,
          projectId: repositoryId,
        }),
      },
    });
  };
  const update = async (
    input: { name?: string; color?: ReturnType<typeof projectLabelPaletteColor> },
    failure: string,
  ) => {
    const result = await updateLabel({ environmentId, input: { id: labelId, ...input } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(failure, result);
    }
  };
  const backToProjects = () => void navigate({ to: PROJECTS_SETTINGS_PATH });
  // The deleted project's page is gone, so it leaves no history entry to return to.
  const leave = () => void navigate({ to: PROJECTS_SETTINGS_PATH, replace: true });
  const remove = async () => {
    if (label === null) return;
    if (await deleteFolder(environmentId, label)) leave();
  };

  if (label === null || entry === null || machineEntry === null) {
    const [title, description] =
      error !== null
        ? ["Could not load projects", error]
        : !isLoaded
          ? ["Loading project…", null]
          : [
              "This project no longer exists",
              "It may have been deleted, or it lives on a machine that is not connected.",
            ];
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <PageContent width="wide" className="gap-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </PageContent>
      </div>
    );
  }

  const org = projectGitHubOrg(label.sourceLinks);
  const showSources = org === null || projectExtraSourceLinks(label.sourceLinks).length > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      {/* The cards give keyboard access, so the viewport stays out of the tab order. */}
      <ScrollArea className="min-h-0 flex-1" viewportTabIndex={-1}>
        <PageContent width="wide">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Button size="sm" variant="ghost-muted" onClick={backToProjects}>
              <ChevronLeftIcon />
              Projects
            </Button>
            <ProjectFolderIcon project={{ environmentId, label }} className="size-4 shrink-0" />
            <ProjectNameEditor
              key={label.name}
              name={label.name}
              editing={renaming}
              canEdit={canEdit}
              onStartEdit={() => setRenaming(true)}
              onCancel={() => setRenaming(false)}
              onSave={async (name) => {
                setRenaming(false);
                await update({ name }, `Could not rename ${label.name}`);
              }}
            />
            {archive.archived || label.description ? (
              <span className="swap-motion min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
                {[archive.archived ? "Archived" : null, label.description || null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
            <span className="ms-auto flex shrink-0 items-center gap-1">
              {/* The project's GitHub org, its one GitHub setting; agents and the
                  repository picker search it. */}
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={!canEdit}
                aria-label={org === null ? "Set GitHub org" : `GitHub org: ${org}. Change`}
                onClick={() => setEditingSources(true)}
              >
                <GitHubIcon />
                {org ?? "Set GitHub org"}
              </Button>
              {archive.archived ? (
                <span key="unarchive" className="swap-motion flex">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!archive.canArchive}
                    onClick={() => void archive.setArchived(false)}
                  >
                    <ArchiveRestoreIcon />
                    Unarchive
                  </Button>
                </span>
              ) : null}
              <ProjectHeaderMenu
                label={label}
                canEdit={canEdit}
                canDelete={canDelete}
                archived={archive.archived}
                canArchive={archive.canArchive}
                machineTargets={machineTargets}
                canMoveToMachine={canMoveToMachine}
                mergeCandidates={mergeCandidates}
                allowedMerges={allowedMerges}
                onMerge={(pair) =>
                  void mergePair(pair).then((merged) => {
                    // Merged away, this project's page is gone too.
                    if (merged && pair.from.key === entry.key) leave();
                  })
                }
                onMoveToMachine={(target) =>
                  void moveProjectToMachine({
                    environmentId,
                    project: { id: label.id, name: label.name },
                    target,
                    // Its threads can run on several machines.
                    fromName: null,
                  })
                }
                onNewChat={() =>
                  void startScratchThread(environmentId, {
                    surface: "chat",
                    projectFolderId: labelId,
                  })
                }
                onRename={() => setRenaming(true)}
                onRecolor={(color) =>
                  void update(
                    { color: projectLabelPaletteColor(color) },
                    `Could not recolor ${label.name}`,
                  )
                }
                onEditDetails={() => setEditingDetails(true)}
                onToggleArchived={() => void archive.setArchived(!archive.archived)}
                onDelete={() => void remove()}
              />
            </span>
          </div>
          {duplicates.map((pair) => (
            <PossibleDuplicateNotice key={pair.key} pair={pair} />
          ))}
          {/* Balanced columns: each card sizes to its content and the next one
              fills under the shortest column, so no gap opens under a short card. */}
          <section
            aria-label={`${label.name} details`}
            className="columns-1 gap-3 md:columns-2 xl:columns-3"
          >
            <ProjectCardSlot>
              <RepositoriesCard
                environmentId={machineId}
                folder={machineEntry}
                rows={repositoryRows}
                onOpenRepository={openRepositorySettings}
                machines={machineOptions}
                onSelectMachine={setPickedMachine}
              />
            </ProjectCardSlot>
            <ProjectCardSlot>
              <RecentCard
                environmentId={environmentId}
                label={label}
                chats={chats}
                work={work}
                exclude={NOTHING_EXCLUDED}
              />
            </ProjectCardSlot>
            <ProjectCardSlot>
              <AgentsCard environmentId={environmentId} environmentIds={machineIds} label={label} />
            </ProjectCardSlot>
            {showSources ? (
              <ProjectCardSlot>
                <SourcesCard environmentId={environmentId} label={label} />
              </ProjectCardSlot>
            ) : null}
            <ProjectCardSlot>
              <FilesCard
                environmentId={machineId}
                label={label}
                resources={files.resources}
                loaded={files.isLoaded}
                error={files.error}
              />
            </ProjectCardSlot>
          </section>
        </PageContent>
      </ScrollArea>
      <OverlayPresence when={editingSources && label}>
        {(label) => (
          <ProjectSourceLinksDialog
            environmentId={environmentId}
            label={label}
            onClose={() => setEditingSources(false)}
          />
        )}
      </OverlayPresence>
      <OverlayPresence when={editingDetails && label}>
        {(label) => (
          <ProjectLabelEditorDialog
            environmentId={environmentId}
            label={label}
            onClose={() => setEditingDetails(false)}
            onDeleted={leave}
          />
        )}
      </OverlayPresence>
    </div>
  );
}
