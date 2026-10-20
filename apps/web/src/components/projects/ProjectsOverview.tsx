import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import type { ProjectLabelId } from "@t3tools/contracts";
import { ProjectLabelEditorDialog } from "../../projectLabels/ProjectLabelEditorDialog";
import {
  projectContentsCount,
  projectFolderSummary,
} from "../../projectLabels/projectContents.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
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
import { openableRowProps, ProjectFoldersContextNote } from "./ProjectView";

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

/** Opens the project editor for a new folder on one machine, then the folder. */
function NewProjectDialog(props: {
  environmentId: EnvironmentId;
  onClose: () => void;
  onCreated: (labelId: ProjectLabelId) => void;
}) {
  return (
    <ProjectLabelEditorDialog
      environmentId={props.environmentId}
      label={null as ProjectLabelWithRepositories | null}
      onClose={props.onClose}
      onCreated={props.onCreated}
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
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" data-panel-flip="start">
            Projects
          </h1>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={createEnvironmentId === null || !canCreate}
            onClick={() => setCreating(true)}
          >
            <FolderPlusIcon className="size-3" />
            New project
          </Button>
        </WorkspacePageHeader>
        <SettingsPageContainer>
          {directory.labels.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  A project is a folder for related chats, Work and repositories.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  disabled={createEnvironmentId === null || !canCreate}
                  onClick={() => setCreating(true)}
                >
                  <FolderPlusIcon />
                  New project
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <SettingsSection title="Projects" hideTitle>
              {directory.labels.map((entry) => {
                const summary = projectFolderSummary(
                  entry.label.repositoryIds.length,
                  projectContentsCount(byProject.get(entry.key)),
                );
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
                        {summary ?? "Empty"}
                      </span>
                    }
                  />
                );
              })}
            </SettingsSection>
          )}
          <ProjectFoldersContextNote />
        </SettingsPageContainer>
      </div>
      <OverlayPresence when={creating && createEnvironmentId}>
        {(environmentId) => (
          <NewProjectDialog
            environmentId={environmentId}
            onClose={() => setCreating(false)}
            onCreated={(labelId) =>
              void navigate({
                to: "/project/$environmentId/$labelId",
                params: { environmentId, labelId },
              })
            }
          />
        )}
      </OverlayPresence>
    </SidebarInset>
  );
}
