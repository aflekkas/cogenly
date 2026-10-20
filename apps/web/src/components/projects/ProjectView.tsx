import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ProjectLabelId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, FolderIcon, MessageCircleIcon, PencilIcon, SettingsIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { useAgents } from "../../agents/agentsClient";
import { isElectron } from "../../env";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  ProjectLabelEditorDialog,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { projectLabelKey } from "../../projectLabels/projectLabels.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { getSidebarProjectSettingsKey } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
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
            {props.repositoryName ? <FolderIcon aria-hidden className="size-3 shrink-0" /> : null}
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

/**
 * One project in the main area: its Work, chats and agents, the repositories
 * it links, and its management (rename, color, description, delete), which
 * used to live in Settings → Projects.
 */
export function ProjectView(props: { environmentId: EnvironmentId; labelId: ProjectLabelId }) {
  const { environmentId, labelId } = props;
  const navigate = useNavigate();
  const { byProject } = useProjectContents();
  const { labels, isLoaded, error } = useEnvironmentProjectLabels(environmentId);
  const label = labels.find((candidate) => candidate.id === labelId) ?? null;
  const contents = byProject.get(projectLabelKey(environmentId, labelId));
  const repositories = useEnvironmentRepositories(environmentId);
  const canEdit = useAtomValue(serverEnvironment.updateProjectLabel.permissionAtom(environmentId));
  const [editing, setEditing] = useState(false);
  const { agents } = useAgents();
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

  const header = (
    <WorkspacePageHeader electron={isElectron} className="border-b border-border">
      <div className="flex min-w-0 flex-1 items-center gap-2" data-panel-flip="start">
        {label ? <ProjectColorDot color={label.color} className="size-2.5" /> : null}
        <h1 className="min-w-0 truncate text-sm font-medium">{label?.name ?? "Project"}</h1>
      </div>
      {label ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canEdit}
          title={canEdit ? undefined : "You don't have permission to change projects here."}
          onClick={() => setEditing(true)}
        >
          <PencilIcon className="size-3" />
          Edit project
        </Button>
      ) : null}
    </WorkspacePageHeader>
  );

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
        ) : label === null ? (
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
            <SettingsSection title="Work" icon={<FolderIcon className="size-3.5" />}>
              {contents && contents.work.length > 0 ? (
                contents.work.map((thread) => (
                  <ProjectThreadRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    repositoryName={
                      repositoryNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                    }
                    onOpen={openThread}
                  />
                ))
              ) : (
                <EmptyRow>No Work in this project yet. Link a repository or tag a thread.</EmptyRow>
              )}
            </SettingsSection>
            <SettingsSection title="Chats" icon={<MessageCircleIcon className="size-3.5" />}>
              {contents && contents.chats.length > 0 ? (
                contents.chats.map((thread) => (
                  <ProjectThreadRow
                    key={`${thread.environmentId}:${thread.id}`}
                    thread={thread}
                    repositoryName={null}
                    onOpen={openThread}
                  />
                ))
              ) : (
                <EmptyRow>No chats tagged with this project.</EmptyRow>
              )}
            </SettingsSection>
            <SettingsSection title="Agents" icon={<BotIcon className="size-3.5" />}>
              {contents && contents.agents.length > 0 ? (
                contents.agents.map((agent) => (
                  <SettingsRow
                    key={`${agent.environmentId}:${agent.id}`}
                    {...openableRowProps(() =>
                      openThread(scopeThreadRef(agent.environmentId, agent.conversationThreadId)),
                    )}
                    title={<span className="min-w-0 truncate">{agent.name}</span>}
                  />
                ))
              ) : (
                <EmptyRow>
                  {agents.length === 0
                    ? "No agents yet."
                    : "No agent has this project in its scope."}
                </EmptyRow>
              )}
            </SettingsSection>
            <SettingsSection
              title="Repositories"
              headerAction={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canEdit}
                  onClick={() => setEditing(true)}
                >
                  Link repositories
                </Button>
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
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Repository settings for ${repository.title}`}
                        onClick={() => openRepositorySettings(repository.id)}
                      >
                        <SettingsIcon />
                      </Button>
                    }
                  />
                ))
              ) : (
                <EmptyRow>No linked repositories.</EmptyRow>
              )}
            </SettingsSection>
            <p className="px-3 text-xs text-muted-foreground sm:px-4">
              Projects are context only. Tagging a chat or linking a repository never changes what
              an agent is allowed to access.
            </p>
          </SettingsPageContainer>
        )}
      </div>
      {editing && label ? (
        <ProjectLabelEditorDialog
          environmentId={environmentId}
          label={label}
          repositories={repositories}
          onClose={() => setEditing(false)}
          onDeleted={() => void navigate({ to: "/project" })}
        />
      ) : null}
    </SidebarInset>
  );
}
