import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import type { ProjectLabelId } from "@t3tools/contracts";
import { ProjectLabelEditorDialog } from "../../projectLabels/ProjectLabelEditorDialog";
import { projectFolderSummary } from "../../projectLabels/projectContents.logic";
import { ProjectColorDot } from "../../projectLabels/ProjectTag";
import { useProjectLabelDirectory } from "../../projectLabels/useProjectLabels";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
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
import type { EnvironmentProjectLabel } from "../../projectLabels/projectLabels.logic";
import { ProjectFolderGrid } from "./ProjectFolderGrid";
import { ProjectFoldersContextNote } from "./ProjectView";

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
 * Every project folder across connected machines as a grid of cards, and
 * where new ones start. Opening a card shows the folder full width.
 */
export function ProjectsOverview(props: ProjectsOverviewSearch) {
  const navigate = useNavigate();
  const directory = useProjectLabelDirectory(useConnectedEnvironmentIds());
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const createEnvironmentId = props.environmentId ?? primaryEnvironmentId;
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(createEnvironmentId),
  );
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<EnvironmentProjectLabel | null>(null);
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
        <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
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
                    variant="brand"
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
              <ProjectFolderGrid
                folders={directory.labels}
                environmentLabel={(entry) =>
                  showEnvironments ? (environmentLabelById.get(entry.environmentId) ?? null) : null
                }
                canCreate={createEnvironmentId !== null && canCreate}
                onOpen={(entry) =>
                  void navigate({
                    to: "/project/$environmentId/$labelId",
                    params: { environmentId: entry.environmentId, labelId: entry.label.id },
                  })
                }
                onRename={setRenaming}
                onCreate={() => setCreating(true)}
              />
            )}
            <ProjectFoldersContextNote />
          </div>
        </div>
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
