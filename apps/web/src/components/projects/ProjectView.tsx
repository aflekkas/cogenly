import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  FolderGit2Icon,
  FolderMinusIcon,
  HammerIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  Settings2Icon,
  SettingsIcon,
  SquarePenIcon,
  TrashIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isElectron } from "../../env";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { cn } from "../../lib/utils";
import {
  ProjectLabelEditorDialog,
  useDeleteProjectFolder,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
import { ProjectRepositoryPicker } from "../../projectLabels/ProjectRepositoryPicker";
import {
  ProjectSourceLinkChips,
  ProjectSourceLinkField,
} from "../../projectLabels/ProjectSourceLinks";
import {
  PROJECT_LABEL_COLORS,
  projectLabelKey,
  projectLabelPaletteColor,
} from "../../projectLabels/projectLabels.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { getSidebarProjectSettingsKey } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AnimatedHeight } from "../AnimatedHeight";
import { FadeSwap } from "../chat/StateTransition";
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
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectFilesSection } from "./ProjectFilesSection";
import { ProjectPanelRow, ProjectPanelSection } from "./ProjectPanelSection";
import { projectPanelSummary, sortRecentFirst } from "./projectPanel.logic";
import { useProjectResources } from "./useProjectResources";

const NO_PERMISSION = "You don't have permission to change projects here.";

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
    <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
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

/** Rename, color, details and delete, in the header's ⋯ menu. */
function ProjectHeaderMenu(props: {
  readonly label: ProjectLabelWithRepositories;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly onRename: () => void;
  readonly onRecolor: (color: string) => void;
  readonly onEditDetails: () => void;
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
        <MenuItem variant="destructive" disabled={!props.canDelete} onClick={props.onDelete}>
          <TrashIcon />
          Delete…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** A page frame with a bare top bar; the page's own header sits in the content column. */
function ProjectPageFrame(props: { readonly children: React.ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} />
        <div className="scroll-fade-y min-h-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable">
          <WorkspacePageContainer width="readable" className="gap-4">
            {props.children}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * One project folder in the main area: its header (folder, name, what it
 * holds, actions, and the way to a new chat in it), then its chats, Work,
 * repositories, files and sources as compact sections. Picking another
 * project crossfades the content in place.
 */
export function ProjectView(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}) {
  return (
    <ProjectPageFrame>
      <FadeSwap
        group="project-page"
        swapKey={projectLabelKey(props.environmentId, props.labelId)}
        className="block w-full"
      >
        <ProjectPage
          key={projectLabelKey(props.environmentId, props.labelId)}
          environmentId={props.environmentId}
          labelId={props.labelId}
        />
      </FadeSwap>
    </ProjectPageFrame>
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
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelRepository.permissionAtom(environmentId),
  );
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelRepository.permissionAtom(environmentId),
  );
  const canLinkSource = useAtomValue(
    serverEnvironment.linkProjectLabelSource.permissionAtom(environmentId),
  );
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, {
    label: "update project",
    reportFailure: false,
  });
  const unlink = useAtomCommand(serverEnvironment.unlinkProjectLabelRepository, {
    label: "remove repository from project",
    reportFailure: false,
  });
  const deleteFolder = useDeleteProjectFolder();
  const { startScratchThread } = useScratchProject();
  const [renaming, setRenaming] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [linkingSource, setLinkingSource] = useState(false);
  const projects = useProjects();
  const projectGroups = useSidebarProjectGroups();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);

  const repositoryNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  const linkedRepositories = useMemo(
    () =>
      label === null
        ? []
        : repositories.filter((repository) => label.repositoryIds.includes(repository.id)),
    [label, repositories],
  );
  const chats = useMemo(() => sortRecentFirst(contents?.chats ?? [], chatActivityAt), [contents]);
  const work = useMemo(() => sortRecentFirst(contents?.work ?? [], chatActivityAt), [contents]);

  const openThread = (threadRef: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
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
  const removeRepository = async (repositoryId: ProjectId, title: string) => {
    const result = await unlink({ environmentId, input: { labelId, repositoryId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportProjectFolderFailure(`Could not remove ${title}`, result);
    }
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
      <div className="flex flex-col gap-1 px-2.5">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
    );
  }

  const summary = projectPanelSummary({
    repositories: linkedRepositories.length,
    chats: chats.length,
    work: work.length,
    files: files.resources.filter((resource) => resource.kind === "file").length,
  });

  const threadRow = (thread: EnvironmentThreadShell, showRepository: boolean) => {
    const repositoryName = showRepository
      ? (repositoryNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null)
      : null;
    return (
      <ProjectPanelRow
        key={`${thread.environmentId}:${thread.id}`}
        icon={showRepository ? <HammerIcon /> : <MessageCircleIcon />}
        title={thread.title}
        meta={repositoryName ?? undefined}
        trailing={formatRelativeTimeLabel(chatActivityAt(thread))}
        onOpen={() => openThread(scopeThreadRef(thread.environmentId, thread.id))}
      />
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 px-2.5">
        <div className="flex items-start gap-4">
          <ProjectFolderIcon color={label.color} className="mt-0.5 size-10" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
            <p className="truncate text-sm tabular-nums text-muted-foreground">
              {summary ?? "Empty"}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="brand"
              onClick={() =>
                void startScratchThread(environmentId, {
                  surface: "chat",
                  projectFolderId: labelId,
                })
              }
            >
              <SquarePenIcon />
              New chat
            </Button>
            <ProjectHeaderMenu
              label={label}
              canEdit={canEdit}
              canDelete={canDelete}
              onRename={() => setRenaming(true)}
              onRecolor={(color) => void update({ color }, `Could not recolor ${label.name}`)}
              onEditDetails={() => setEditingDetails(true)}
              onDelete={() => void remove()}
            />
          </span>
        </div>
        {label.description ? (
          <p className="text-sm text-muted-foreground">{label.description}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        <ProjectPanelSection title="Chats" count={chats.length}>
          {chats.map((thread) => threadRow(thread, false))}
        </ProjectPanelSection>
        <ProjectPanelSection
          title="Work"
          count={work.length}
          action={
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                void startScratchThread(environmentId, {
                  surface: "work",
                  projectFolderId: labelId,
                })
              }
            >
              <PlusIcon />
              New Work
            </Button>
          }
        >
          {work.map((thread) => threadRow(thread, true))}
        </ProjectPanelSection>
        <ProjectPanelSection
          title="Repositories"
          count={linkedRepositories.length}
          action={
            <ProjectRepositoryPicker
              folder={entry}
              repositories={repositories}
              folderByRepository={directory.folderByRepository}
              disabled={!canLink}
              triggerLabel="Add"
            />
          }
        >
          {linkedRepositories.map((repository) => (
            <ProjectPanelRow
              key={repository.id}
              icon={<FolderGit2Icon />}
              title={repository.title}
              actions={
                <>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Repository settings for ${repository.title}`}
                    onClick={() => openRepositorySettings(repository.id)}
                  >
                    <SettingsIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${repository.title} from ${label.name}`}
                    title={canUnlink ? "Remove from project" : NO_PERMISSION}
                    disabled={!canUnlink}
                    onClick={() => void removeRepository(repository.id, repository.title)}
                  >
                    <FolderMinusIcon />
                  </Button>
                </>
              }
            />
          ))}
        </ProjectPanelSection>
        <ProjectFilesSection
          environmentId={environmentId}
          labelId={labelId}
          resources={files.resources}
          loaded={files.isLoaded}
          error={files.error}
        />
        <ProjectPanelSection
          title="Sources"
          count={label.sourceLinks.length}
          action={
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canLinkSource && !linkingSource}
              title={canLinkSource ? undefined : NO_PERMISSION}
              aria-expanded={linkingSource}
              onClick={() => setLinkingSource((current) => !current)}
            >
              {linkingSource ? (
                "Done"
              ) : (
                <>
                  <PlusIcon />
                  Link GitHub
                </>
              )}
            </Button>
          }
        >
          <AnimatedHeight>
            <div
              className={cn(
                "flex flex-col gap-2 px-2.5",
                (label.sourceLinks.length > 0 || linkingSource) && "py-1",
              )}
            >
              {label.sourceLinks.length > 0 ? (
                <ProjectSourceLinkChips environmentId={environmentId} label={label} />
              ) : null}
              {linkingSource ? (
                <div className="reveal-motion">
                  <ProjectSourceLinkField
                    environmentId={environmentId}
                    label={label}
                    autoFocus
                    onLinked={() => setLinkingSource(false)}
                  />
                </div>
              ) : null}
            </div>
          </AnimatedHeight>
        </ProjectPanelSection>
      </div>
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
