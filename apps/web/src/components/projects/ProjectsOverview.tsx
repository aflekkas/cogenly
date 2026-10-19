import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, TagIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import {
  ProjectLabelEditorDialog,
  useEnvironmentRepositories,
} from "../../projectLabels/ProjectLabelEditorDialog";
import { projectContentsCount } from "../../projectLabels/projectContents.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { openableRowProps } from "./ProjectView";

export interface ProjectsOverviewSearch {
  readonly create?: true | undefined;
  /** The machine a new project is created on; defaults to the primary one. */
  readonly environmentId?: EnvironmentId | undefined;
}

export function validateProjectsOverviewSearch(
  raw: Record<string, unknown>,
): ProjectsOverviewSearch {
  return {
    ...(raw.create === true || raw.create === "1" || raw.create === "true"
      ? { create: true as const }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
  };
}

/** Opens the project editor for a new project on one machine. */
function NewProjectDialog(props: { environmentId: EnvironmentId; onClose: () => void }) {
  const repositories = useEnvironmentRepositories(props.environmentId);
  return (
    <ProjectLabelEditorDialog
      environmentId={props.environmentId}
      label={null as ProjectLabelWithRepositories | null}
      repositories={repositories}
      onClose={props.onClose}
    />
  );
}

/**
 * Every project across connected machines, and where new ones start. The
 * Projects sidebar lists the same projects; this page is what links to
 * "manage projects" land on.
 */
export function ProjectsOverview(props: ProjectsOverviewSearch) {
  const navigate = useNavigate();
  const { directory, byProject } = useProjectContents();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const createEnvironmentId = props.environmentId ?? primaryEnvironmentId;
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(createEnvironmentId),
  );
  const [creating, setCreating] = useState(false);
  const openedCreate = useRef(false);
  useEffect(() => {
    if (!props.create || openedCreate.current || !canCreate || createEnvironmentId === null) return;
    openedCreate.current = true;
    setCreating(true);
  }, [canCreate, createEnvironmentId, props.create]);
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const showEnvironments = new Set(directory.labels.map((entry) => entry.environmentId)).size > 1;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Projects</h1>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={createEnvironmentId === null || !canCreate}
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-3" />
            New project
          </Button>
        </WorkspacePageHeader>
        <SettingsPageContainer>
          {directory.labels.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TagIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Tag chats and Work with a project. A project can link several repositories.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <SettingsSection title="Projects" hideTitle>
              {directory.labels.map((entry) => {
                const count = projectContentsCount(byProject.get(entry.key));
                return (
                  <SettingsRow
                    key={entry.key}
                    {...openableRowProps(
                      () =>
                        void navigate({
                          to: "/project/$environmentId/$labelId",
                          params: { environmentId: entry.environmentId, labelId: entry.label.id },
                        }),
                    )}
                    title={
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectColorDot color={entry.label.color} />
                        <span className="truncate">{entry.label.name}</span>
                      </span>
                    }
                    description={
                      [
                        entry.label.description,
                        showEnvironments ? environmentLabelById.get(entry.environmentId) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined
                    }
                    control={
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {count === 1 ? "1 item" : `${count} items`}
                      </span>
                    }
                  />
                );
              })}
            </SettingsSection>
          )}
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            Projects are context only. Tagging a chat or linking a repository never changes what an
            agent is allowed to access.
          </p>
        </SettingsPageContainer>
      </div>
      {creating && createEnvironmentId !== null ? (
        <NewProjectDialog environmentId={createEnvironmentId} onClose={() => setCreating(false)} />
      ) : null}
    </SidebarInset>
  );
}
