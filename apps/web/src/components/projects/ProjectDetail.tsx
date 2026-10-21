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
  TrashIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

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
import { ProjectRepositoryPicker } from "../../projectLabels/ProjectRepositoryPicker";
import {
  ProjectSourceLinkChips,
  ProjectSourceLinkField,
} from "../../projectLabels/ProjectSourceLinks";
import { PROJECT_LABEL_COLORS, projectLabelKey } from "../../projectLabels/projectLabels.logic";
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
import { GitHubIcon } from "../Icons";
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
import { ProjectFilesSection } from "./ProjectFilesSection";
import { ProjectPanelEmptyRow, ProjectPanelRow, ProjectPanelSection } from "./ProjectPanelSection";
import { projectPanelSummary, sortRecentFirst } from "./projectPanel.logic";

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
    <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
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
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Project actions" />}
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
              value={props.label.color ?? "gray"}
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

/**
 * One project folder in the panel: its header (folder, name, what it holds,
 * actions), then its chats, Work, repositories, files and sources as compact
 * sections. Opening a thread or a repository's settings leaves the panel.
 */
export function ProjectDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
  readonly onClose: () => void;
}) {
  const { environmentId, labelId } = props;
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const { labels, isLoaded, error } = useEnvironmentProjectLabels(environmentId);
  const label = labels.find((candidate) => candidate.id === labelId) ?? null;
  const entry = directory.byKey.get(projectLabelKey(environmentId, labelId)) ?? null;
  const contents = byProject.get(projectLabelKey(environmentId, labelId));
  const repositories = useEnvironmentRepositories(environmentId);
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
  const remove = async () => {
    if (label === null) return;
    if (await deleteFolder(environmentId, label)) props.onClose();
  };

  const closeButton = (
    <Button size="icon-xs" variant="ghost-muted" aria-label="Close project" onClick={props.onClose}>
      <XIcon />
    </Button>
  );

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
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {closeButton}
        </div>
      </div>
    );
  }

  const summary = projectPanelSummary({
    repositories: linkedRepositories.length,
    chats: chats.length,
    work: work.length,
    files: 0,
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <ProjectFolderIcon color={label.color} className="mt-0.5 size-8" />
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
            <p className="truncate text-xs tabular-nums text-muted-foreground">
              {summary ?? "Empty"}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-0.5">
            <ProjectHeaderMenu
              label={label}
              canEdit={canEdit}
              canDelete={canDelete}
              onRename={() => setRenaming(true)}
              onRecolor={(color) => void update({ color }, `Could not recolor ${label.name}`)}
              onEditDetails={() => setEditingDetails(true)}
              onDelete={() => void remove()}
            />
            {closeButton}
          </span>
        </div>
        {label.description ? (
          <p className="text-sm text-muted-foreground">{label.description}</p>
        ) : null}
      </div>
      <div className="scroll-fade-y flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-4 scrollbar-gutter-stable">
        <ProjectPanelSection
          title="Chats"
          count={chats.length}
          action={
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                void startScratchThread(environmentId, {
                  surface: "chat",
                  projectFolderId: labelId,
                })
              }
            >
              <PlusIcon />
              New chat
            </Button>
          }
        >
          {chats.length > 0 ? (
            chats.map((thread) => threadRow(thread, false))
          ) : (
            <ProjectPanelEmptyRow>No chats yet.</ProjectPanelEmptyRow>
          )}
        </ProjectPanelSection>
        <ProjectPanelSection title="Work" count={work.length}>
          {work.length > 0 ? (
            work.map((thread) => threadRow(thread, true))
          ) : (
            <ProjectPanelEmptyRow>No Work yet.</ProjectPanelEmptyRow>
          )}
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
          {linkedRepositories.length > 0 ? (
            linkedRepositories.map((repository) => (
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
            ))
          ) : (
            <ProjectPanelEmptyRow>No repositories yet.</ProjectPanelEmptyRow>
          )}
        </ProjectPanelSection>
        <ProjectFilesSection environmentId={environmentId} labelId={labelId} />
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
                  <GitHubIcon aria-hidden />
                  Link GitHub…
                </>
              )}
            </Button>
          }
        >
          <AnimatedHeight>
            <div className="flex flex-col gap-2 px-2.5 py-1">
              {label.sourceLinks.length > 0 ? (
                <ProjectSourceLinkChips environmentId={environmentId} label={label} />
              ) : !linkingSource ? (
                <p className="flex h-7 items-center text-sm text-muted-foreground">
                  No GitHub orgs or repositories linked.
                </p>
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
            onDeleted={props.onClose}
          />
        )}
      </OverlayPresence>
    </div>
  );
}
