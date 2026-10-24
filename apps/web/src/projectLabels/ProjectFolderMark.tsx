import type { EnvironmentId, ProjectSourceLink } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { RepositoryRemoteIcon } from "../components/ProjectFavicon";
import { cn } from "../lib/utils";
import { projectIconSource, projectLabelColorValue } from "./projectLabels.logic";

// Sized to the capitals of the hero sentence and resting on its baseline.
export const HERO_INLINE_ICON_STYLE: CSSProperties = {
  width: "0.78em",
  height: "0.78em",
  verticalAlign: "-0.06em",
  marginInlineEnd: "0.28em",
};

/** The slice of a project its icon reads. */
export interface ProjectIconProject {
  readonly environmentId: EnvironmentId;
  readonly label: {
    readonly color?: string | undefined;
    readonly sourceLinks?: ReadonlyArray<ProjectSourceLink> | undefined;
  };
}

/**
 * A project's icon, where a project is named in a line of text: the avatar of
 * the GitHub owner it links (see `projectIconSource`), else a folder in its
 * color. Pass `project` wherever the project itself is known; `color` alone
 * draws the plain folder (a color swatch, or a project not loaded yet).
 */
export function ProjectFolderIcon(props: {
  project?: ProjectIconProject | null | undefined;
  color?: string | undefined;
  className?: string;
  /** For icons sized in em to running text, as in the hero sentence. */
  style?: CSSProperties;
}) {
  const color = props.color ?? props.project?.label.color;
  const folder = (
    <FolderIcon
      aria-hidden
      className={cn("size-3 shrink-0 text-(--label)", props.className)}
      style={{ ...props.style, "--label": projectLabelColorValue(color) } as CSSProperties}
    />
  );
  const source = props.project ? projectIconSource(props.project.label) : null;
  if (props.project == null || source?.kind !== "owner-avatar") return folder;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-3 shrink-0", props.className)}
      style={props.style}
    >
      <RepositoryRemoteIcon
        environmentId={props.project.environmentId}
        remote={source.remote}
        iconPath={null}
        className="size-full rounded-xs"
        fallback={folder}
      />
    </span>
  );
}
