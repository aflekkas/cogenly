import type { EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { FolderOpenIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProjectPanelEmptyRow, ProjectPanelSection } from "./ProjectPanelSection";

/**
 * The project's files. The file backend is still being built: this renders
 * one short dropzone line today and is the seam it plugs into. "Open folder"
 * shows once a caller can reveal the project's folder on disk.
 */
export function ProjectFilesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
  /** Reveals the project's folder; absent until the desktop bridge can. */
  readonly onOpenFolder?: (() => void) | null;
}) {
  return (
    <ProjectPanelSection
      title="Files"
      count={0}
      action={
        props.onOpenFolder ? (
          <Button size="xs" variant="ghost-muted" onClick={props.onOpenFolder}>
            <FolderOpenIcon />
            Open folder
          </Button>
        ) : undefined
      }
    >
      <ProjectPanelEmptyRow>
        <span className="truncate" data-project={`${props.environmentId}:${props.labelId}`}>
          Drop files here to add them.
        </span>
      </ProjectPanelEmptyRow>
    </ProjectPanelSection>
  );
}
