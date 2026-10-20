import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ProjectLabelId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderMinusIcon,
  HammerIcon,
  MessageCircleIcon,
  PencilIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  ProjectLabelEditorDialog,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { projectLabelKey } from "../../projectLabels/projectLabels.logic";
import { ProjectRepositoryPicker } from "../../projectLabels/ProjectRepositoryPicker";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { getSidebarProjectSettingsKey } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
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
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** Row props that make a whole settings row open something. */
export function openableRowProps(onOpen: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    className:
      "cursor-pointer outline-none state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    onClick: onOpen,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onOpen();
    },
  } as const;
}

function ProjectThreadRow(props: {
  thread: EnvironmentThreadShell;
  repositoryName: string | null;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const meta = [props.repositoryName, thread.branch].filter(Boolean).join(" · ");
  return (
    <SettingsRow
      {...openableRowProps(() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id)))}
      title={<span className="min-w-0 truncate">{thread.title}</span>}
      description={
        meta ? (
          <span className="flex min-w-0 items-center gap-1">
            {props.repositoryName ? (
              <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 fade-truncate">{meta}</span>
          </span>
        ) : undefined
      }
      control={
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
        </span>
      }
    />
  );
}

function EmptyRow(props: { children: ReactNode }) {
  return <SettingsRow title={<span className="text-muted-foreground">{props.children}</span>} />;
}

/** The one line every folder surface ends on. */
export function ProjectFoldersContextNote() {
  return (
    <p className="px-3 text-xs text-muted-foreground sm:px-4">
      Projects are context only. They never change what an agent can access.
    </p>
  );
}

/**
 * One project folder in the main area: its repositories (add, remove), its
 * chats and Work, and its management (rename, color, description, delete).
 */
export function ProjectView(props: { environmentId: EnvironmentId; labelId: ProjectLabelId }) {
  const { environmentId, labelId } = props;
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const { labels, isLoaded, error } = useEnvironmentProjectLabels(environmentId);
  const label = labels.find((candidate) => candidate.id === labelId) ?? null;
  const entry = directory.byKey.get(projectLabelKey(environmentId, labelId)) ?? null;
  const contents = byProject.get(projectLabelKey(environmentId, labelId));
  const repositories = useEnvironmentRepositories(environmentId);
  const canEdit = useAtomValue(serverEnvironment.updateProjectLabel.permissionAtom(environmentId));
  const canLink = useAtomValue(
    serverEnvironment.linkProjectLabelRepository.permissionAtom(environmentId),
  );
  const canUnlink = useAtomValue(
    serverEnvironment.unlinkProjectLabelRepository.permissionAtom(environmentId),
  );
  const unlink = useAtomCommand(serverEnvironment.unlinkProjectLabelRepository, {
    label: "remove repository from project",
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
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

  const chats = contents?.chats ?? [];
  const work = contents?.work ?? [];
  const isEmpty = linkedRepositories.length === 0 && chats.length === 0 && work.length === 0;
  const noPermission = "You don't have permission to change projects here.";

  const header = (
    <WorkspacePageHeader electron={isElectron} className="border-b border-border">
      <div className="flex min-w-0 flex-1 items-center gap-2" data-panel-flip="start">
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Back to Projects"
          onClick={() => void navigate({ to: "/project" })}
        >
          <ArrowLeftIcon className="size-3" />
          Projects
        </Button>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        {label ? <ProjectColorDot color={label.color} className="size-2.5" /> : null}
        <h1 className="min-w-0 truncate text-sm font-medium">{label?.name ?? "Project"}</h1>
      </div>
      {label ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canEdit}
          title={canEdit ? undefined : noPermission}
          onClick={() => setEditing(true)}
        >
          <PencilIcon className="size-3" />
          Edit
        </Button>
      ) : null}
    </WorkspacePageHeader>
  );

  const threadRows = (threads: ReadonlyArray<EnvironmentThreadShell>, showRepository: boolean) =>
    threads.map((thread) => (
      <ProjectThreadRow
        key={`${thread.environmentId}:${thread.id}`}
        thread={thread}
        repositoryName={
          showRepository
            ? (repositoryNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null)
            : null
        }
        onOpen={openThread}
      />
    ));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {header}
        {error !== null ? (
          <SettingsPageContainer>
            <SettingsSection title="Project">
              <SettingsRow title="Could not load projects" description={error} />
            </SettingsSection>
          </SettingsPageContainer>
        ) : !isLoaded ? (
          <SettingsPageContainer>
            <SettingsSection title="Project">
              <SettingsRow title="Loading project…" />
            </SettingsSection>
          </SettingsPageContainer>
        ) : label === null || entry === null ? (
          <SettingsPageContainer>
            <SettingsSection title="Project">
              <SettingsRow
                title="This project no longer exists"
                description="It may have been deleted, or it lives on a machine that is not connected."
              />
            </SettingsSection>
          </SettingsPageContainer>
        ) : (
          <SettingsPageContainer>
            {label.description ? (
              <p className="px-3 text-sm text-muted-foreground sm:px-4">{label.description}</p>
            ) : null}
            {isEmpty ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderIcon />
                  </EmptyMedia>
                  <EmptyTitle>{label.name} is empty</EmptyTitle>
                  <EmptyDescription>
                    Add a repository and its Work files here. To file a chat, right-click it in the
                    sidebar and choose Move to folder.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <ProjectRepositoryPicker
                    folder={entry}
                    repositories={repositories}
                    folderByRepository={directory.folderByRepository}
                    disabled={!canLink}
                  />
                </EmptyContent>
              </Empty>
            ) : null}
            {!isEmpty ? (
              <SettingsSection
                title="Repositories"
                icon={<FolderGit2Icon className="size-3.5" />}
                headerAction={
                  <ProjectRepositoryPicker
                    folder={entry}
                    repositories={repositories}
                    folderByRepository={directory.folderByRepository}
                    disabled={!canLink}
                  />
                }
              >
                {linkedRepositories.length > 0 ? (
                  linkedRepositories.map((repository) => (
                    <SettingsRow
                      key={repository.id}
                      title={
                        <span className="flex min-w-0 items-center gap-2">
                          <ProjectFavicon project={repository} className="size-4 shrink-0" />
                          <span className="truncate">{repository.title}</span>
                        </span>
                      }
                      control={
                        <span className="flex items-center gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Repository settings for ${repository.title}`}
                            onClick={() => openRepositorySettings(repository.id)}
                          >
                            <SettingsIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove ${repository.title} from ${label.name}`}
                            title={canUnlink ? "Remove from project" : noPermission}
                            disabled={!canUnlink}
                            onClick={() => void removeRepository(repository.id, repository.title)}
                          >
                            <FolderMinusIcon />
                          </Button>
                        </span>
                      }
                    />
                  ))
                ) : (
                  <EmptyRow>No repositories. Their Work files here once added.</EmptyRow>
                )}
              </SettingsSection>
            ) : null}
            {!isEmpty ? (
              <SettingsSection title="Chats" icon={<MessageCircleIcon className="size-3.5" />}>
                {chats.length > 0 ? (
                  threadRows(chats, false)
                ) : (
                  <EmptyRow>No chats. Right-click a chat and choose Move to folder.</EmptyRow>
                )}
              </SettingsSection>
            ) : null}
            {!isEmpty ? (
              <SettingsSection title="Work" icon={<HammerIcon className="size-3.5" />}>
                {work.length > 0 ? threadRows(work, true) : <EmptyRow>No Work yet.</EmptyRow>}
              </SettingsSection>
            ) : null}
            <ProjectFoldersContextNote />
          </SettingsPageContainer>
        )}
      </div>
      <OverlayPresence when={editing && label}>
        {(label) => (
          <ProjectLabelEditorDialog
            environmentId={environmentId}
            label={label}
            onClose={() => setEditing(false)}
            onDeleted={() => void navigate({ to: "/project" })}
          />
        )}
      </OverlayPresence>
    </SidebarInset>
  );
}
