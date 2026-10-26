import { FolderMinusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProjectFolderIcon, type ProjectIconProject } from "./ProjectFolderMark";
import { PickerRowContent } from "./RepositorySourceRows";

/**
 * A project's row in every project picker (composer, agent, multi-project, Start Work):
 * its icon and name, checked while chosen. `project: null` is the "No project"
 * row, or pass `icon` for an action row such as "New project…".
 */
export function ProjectPickerRow(
  props: {
    readonly label: ReactNode;
    readonly chosen?: boolean;
    /** Opens the project's own list, as Start Work's project rows do. */
    readonly submenu?: boolean;
    /** A trailing figure, such as how many items the project holds here. */
    readonly meta?: ReactNode;
  } & (
    | { readonly project: ProjectIconProject | null; readonly icon?: never }
    | { readonly project?: never; readonly icon: ReactNode }
  ),
) {
  const icon =
    props.icon ??
    (props.project ? (
      <ProjectFolderIcon project={props.project} className="size-4" />
    ) : (
      <FolderMinusIcon />
    ));
  return (
    <PickerRowContent
      icon={icon}
      label={props.label}
      chosen={props.chosen ?? false}
      submenu={props.submenu ?? false}
      meta={props.meta}
    />
  );
}
