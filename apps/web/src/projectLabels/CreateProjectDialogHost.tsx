import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

import { OverlayPresence } from "../components/ui/overlay-presence";
import { ProjectLabelEditorDialog } from "./ProjectLabelEditorDialog";

export interface CreateProjectRequest {
  /** The machine the project is created on. */
  readonly environmentId: EnvironmentId;
  /** Prefills the name, such as what was typed into a picker's search. */
  readonly initialName?: string;
  readonly initialColor?: string;
  /**
   * After the project exists, e.g. to pick it in the picker that asked. Without
   * one, the new project's page opens.
   */
  readonly onCreated?: (labelId: ProjectLabelId, name: string) => void;
}

const useCreateProjectDialogStore = create<{ readonly request: CreateProjectRequest | null }>()(
  () => ({ request: null }),
);

/**
 * Every "New project" entry point (pickers, the command palette, the sidebar,
 * the projects page) opens this one dialog.
 */
export function openCreateProjectDialog(request: CreateProjectRequest) {
  useCreateProjectDialogStore.setState({ request });
}

/** Mounted once at the app root; renders the dialog `openCreateProjectDialog` asks for. */
export function CreateProjectDialogHost() {
  const navigate = useNavigate();
  const request = useCreateProjectDialogStore((store) => store.request);
  return (
    <OverlayPresence when={request}>
      {(shown) => (
        <ProjectLabelEditorDialog
          environmentId={shown.environmentId}
          label={null}
          {...(shown.initialName !== undefined ? { initialName: shown.initialName } : {})}
          {...(shown.initialColor !== undefined ? { initialColor: shown.initialColor } : {})}
          onClose={() => useCreateProjectDialogStore.setState({ request: null })}
          onCreated={(labelId, name) => {
            if (shown.onCreated) {
              shown.onCreated(labelId, name);
              return;
            }
            void navigate({
              to: "/project/$environmentId/$labelId",
              params: { environmentId: shown.environmentId, labelId },
            });
          }}
        />
      )}
    </OverlayPresence>
  );
}
