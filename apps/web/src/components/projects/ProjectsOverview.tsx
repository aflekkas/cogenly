import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import type { ProjectLabelId } from "@t3tools/contracts";
import { ProjectLabelEditorDialog } from "../../projectLabels/ProjectLabelEditorDialog";
import { useProjectContents } from "../../projectLabels/useProjectContents";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import { chatActivityAt } from "../sidebar/modes/sidebarModes.logic";
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
import { WORKSPACE_PAGE_HEADER_INSET_CLASS, WorkspacePageHeader } from "../WorkspacePageHeader";
import type { EnvironmentProjectLabel } from "../../projectLabels/projectLabels.logic";
import { ProjectFolderList } from "./ProjectFolderList";
import { ProjectSourceLinksDialog } from "../../projectLabels/ProjectSourceLinks";

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
 * Every project folder across connected machines as a list of rows, and
 * where new ones start. Opening a row shows the folder full width.
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
  const [renaming, setRenaming] = useState<EnvironmentProjectLabel | null>(null);
  const [linking, setLinking] = useState<EnvironmentProjectLabel | null>(null);
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
  // Newest chat or Work in the folder; each list is already newest first.
  const activityLabel = (entry: EnvironmentProjectLabel) => {
    const contents = byProject.get(entry.key);
    const latest = [contents?.chats[0], contents?.work[0]]
      .filter((thread) => thread !== undefined)
      .map(chatActivityAt)
      .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0];
    return latest === undefined ? null : formatRelativeTimeLabel(latest) || null;
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1
            className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight"
            data-panel-flip="start"
          >
            Projects
          </h1>
          <Button
            size="sm"
            variant="outline"
            disabled={createEnvironmentId === null || !canCreate}
            onClick={() => setCreating(true)}
          >
            <FolderPlusIcon />
            New project
          </Button>
        </WorkspacePageHeader>
        <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable">
          {directory.labels.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  A project is a folder for related chats, Work and repositories. Projects are
                  context only; they never change what an agent can access.
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
            <div className={cn("py-2", WORKSPACE_PAGE_HEADER_INSET_CLASS)}>
              <ProjectFolderList
                folders={directory.labels}
                environmentLabel={(entry) =>
                  showEnvironments ? (environmentLabelById.get(entry.environmentId) ?? null) : null
                }
                activityLabel={activityLabel}
                onOpen={(entry) =>
                  void navigate({
                    to: "/project/$environmentId/$labelId",
                    params: { environmentId: entry.environmentId, labelId: entry.label.id },
                  })
                }
                onRename={setRenaming}
                onLinkSources={setLinking}
              />
            </div>
          )}
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
      <OverlayPresence when={linking}>
        {(entry) => (
          <ProjectSourceLinksDialog
            environmentId={entry.environmentId}
            label={entry.label}
            onClose={() => setLinking(null)}
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
