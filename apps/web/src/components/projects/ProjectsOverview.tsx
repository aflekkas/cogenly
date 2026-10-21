import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ProjectLabelEditorDialog } from "../../projectLabels/ProjectLabelEditorDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
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
 * Projects mode with nothing picked: the list is the sidebar, so the main
 * area only says to pick one, and offers a new project. `?create` opens the
 * editor straight away (the sidebar's new button lands here).
 */
export function ProjectsOverview(props: ProjectsOverviewSearch) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} />
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>Select a project</EmptyTitle>
            <EmptyDescription>
              Pick one in the sidebar to start a chat in it and see what it holds.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              disabled={createEnvironmentId === null || !canCreate}
              onClick={() => setCreating(true)}
            >
              <FolderPlusIcon />
              New project
            </Button>
          </EmptyContent>
        </Empty>
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
