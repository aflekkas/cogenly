import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PanelRightIcon,
  PencilIcon,
  Settings2Icon,
  SquarePenIcon,
  TrashIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  ProjectLabelEditorDialog,
  useDeleteProjectFolder,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
import {
  PROJECT_LABEL_COLORS,
  projectLabelKey,
  projectLabelPaletteColor,
} from "../../projectLabels/projectLabels.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjectArchive } from "../../projectLabels/useProjectArchive";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { getSidebarProjectSettingsKey } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
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
import { OverlayPresence } from "../ui/overlay-presence";
import { Sheet, SheetPopup } from "../ui/sheet";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectChatColumn } from "./ProjectChatColumn";
import {
  AgentsCard,
  FilesCard,
  InstructionsCard,
  RecentCard,
  RepositoriesCard,
  SourcesCard,
} from "./ProjectHomeCards";
import { sortRecentFirst } from "./projectPanel.logic";
import { useProjectChatThread } from "./useProjectChatThread";
import { useProjectInstructions } from "./useProjectInstructions";
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
    <h1 className="min-w-0 truncate text-card/5 font-semibold tracking-tight">
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

/**
 * A separate chat in the project, rename, color, details, archive and delete,
 * in the header's ⋯ menu.
 */
function ProjectHeaderMenu(props: {
  readonly label: ProjectLabelWithRepositories;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly archived: boolean;
  readonly canArchive: boolean;
  readonly onNewChat: () => void;
  readonly onRename: () => void;
  readonly onRecolor: (color: string) => void;
  readonly onEditDetails: () => void;
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
          New separate chat
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

/**
 * One project in the main area, as its home: a compact header, the project's
 * one persistent conversation in the main column (the same thread on every
 * visit and device, `projectChatThreadId`), and the cards it is built from (instructions,
 * repositories, sources, files, recent threads, agents) in a column that
 * scrolls on its own. Narrow windows move the cards into a sheet the header
 * toggles. Picking another project fades the new page in.
 */
export function ProjectView(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <ProjectPage
        key={projectLabelKey(props.environmentId, props.labelId)}
        environmentId={props.environmentId}
        labelId={props.labelId}
      />
    </SidebarInset>
  );
}

function ProjectPage(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  const { environmentId, labelId } = props;
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const { labels, isLoaded, error } = useEnvironmentProjectLabels(environmentId);
  const label = labels.find((candidate) => candidate.id === labelId) ?? null;
  const entry = directory.byKey.get(projectLabelKey(environmentId, labelId)) ?? null;
  const contents = byProject.get(projectLabelKey(environmentId, labelId));
  const repositories = useEnvironmentRepositories(environmentId);
  const files = useProjectResources(environmentId, labelId);
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
  const { startScratchThread } = useScratchProject();
  const [renaming, setRenaming] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const cardsInline = useMediaQuery("lg");
  const projects = useProjects();
  const projectGroups = useSidebarProjectGroups();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);

  const linkedRepositories = useMemo(
    () =>
      label === null
        ? []
        : repositories.filter((repository) => label.repositoryIds.includes(repository.id)),
    [label, repositories],
  );
  const chats = useMemo(() => sortRecentFirst(contents?.chats ?? [], chatActivityAt), [contents]);
  const work = useMemo(() => sortRecentFirst(contents?.work ?? [], chatActivityAt), [contents]);
  const instructions = useProjectInstructions(environmentId, label);
  const chat = useProjectChatThread(environmentId, label);
  const projectChatKey = chat.status === "ready" ? scopedThreadKey(chat.threadRef) : null;
  const excludeFromRecent = useMemo(
    () => new Set(projectChatKey === null ? [] : [projectChatKey]),
    [projectChatKey],
  );

  const openRepositorySettings = (repositoryId: ProjectId) => {
    const group = projectGroups.find((candidate) =>
      candidate.memberProjectRefs.some(
        (ref) => ref.environmentId === environmentId && ref.projectId === repositoryId,
      ),
    );
    if (!group) return;
    void navigate({
      to: "/projects/$projectKey",
      params: {
        projectKey: getSidebarProjectSettingsKey(group, groupingSettings, projects, {
          environmentId,
          projectId: repositoryId,
        }),
      },
    });
  };
  const update = async (input: { name?: string; color?: string }, failure: string) => {
    const result = await updateLabel({ environmentId, input: { id: labelId, ...input } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(failure, result);
    }
  };
  // The deleted project's page is gone, so it leaves no history entry to return to.
  const leave = () => void navigate({ to: "/project", replace: true });
  const remove = async () => {
    if (label === null) return;
    if (await deleteFolder(environmentId, label)) leave();
  };

  if (error !== null || !isLoaded || label === null || entry === null) {
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
        <WorkspacePageHeader electron={isElectron} />
        <div className="swap-motion flex flex-col gap-1 px-6 pt-4">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
    );
  }

  const cards = (
    <div className="flex flex-col gap-2 p-3 pb-4">
      <InstructionsCard instructions={instructions} canEdit={canEdit} />
      <RepositoriesCard
        environmentId={environmentId}
        label={label}
        folder={entry}
        repositories={repositories}
        linkedRepositories={linkedRepositories}
        folderByRepository={directory.folderByRepository}
        onOpenRepository={openRepositorySettings}
      />
      <SourcesCard environmentId={environmentId} label={label} />
      <FilesCard
        environmentId={environmentId}
        label={label}
        resources={files.resources}
        loaded={files.isLoaded}
        error={files.error}
      />
      <RecentCard
        environmentId={environmentId}
        label={label}
        chats={chats}
        work={work}
        exclude={excludeFromRecent}
      />
      <AgentsCard environmentId={environmentId} label={label} />
    </div>
  );

  return (
    <div className="swap-motion flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <ProjectFolderIcon color={label.color} className="size-6 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
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
            <p className="swap-motion truncate text-xs text-muted-foreground">
              {[archive.archived ? "Archived" : null, label.description || null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <span className="flex shrink-0 items-center gap-1">
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
          {cardsInline ? null : (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Project details"
              aria-expanded={cardsOpen}
              onClick={() => setCardsOpen((open) => !open)}
            >
              <PanelRightIcon />
            </Button>
          )}
          <ProjectHeaderMenu
            label={label}
            canEdit={canEdit}
            canDelete={canDelete}
            archived={archive.archived}
            canArchive={archive.canArchive}
            onNewChat={() =>
              void startScratchThread(environmentId, {
                surface: "chat",
                projectFolderId: labelId,
              })
            }
            onRename={() => setRenaming(true)}
            onRecolor={(color) => void update({ color }, `Could not recolor ${label.name}`)}
            onEditDetails={() => setEditingDetails(true)}
            onToggleArchived={() => void archive.setArchived(!archive.archived)}
            onDelete={() => void remove()}
          />
        </span>
      </WorkspacePageHeader>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ProjectChatColumn label={label} chat={chat} />
        </div>
        {cardsInline ? (
          <aside
            aria-label={`${label.name} details`}
            className="scroll-fade-y w-82 shrink-0 overflow-y-auto overscroll-contain border-s border-border"
          >
            {cards}
          </aside>
        ) : null}
      </div>
      {cardsInline ? null : (
        <Sheet open={cardsOpen} onOpenChange={setCardsOpen}>
          <SheetPopup side="right" aria-label={`${label.name} details`}>
            <div className="min-h-0 flex-1 overflow-y-auto pt-10">{cards}</div>
          </SheetPopup>
        </Sheet>
      )}
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
