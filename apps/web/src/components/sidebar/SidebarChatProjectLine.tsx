import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { ProjectFolderIcon, type ProjectIconProject } from "~/projectLabels/ProjectFolderMark";

export interface SidebarChatProject {
  readonly name: string;
  readonly color: string | undefined;
  /** The project itself, for its icon. */
  readonly icon: ProjectIconProject;
}

/**
 * The muted second line of a Chats row in a project: the project's folder in
 * its color, then its name. It keeps the last project while it collapses, so
 * a chat moved out of its project fades and shrinks rather than going blank.
 * The row animates its own height alongside.
 */
export function SidebarChatProjectLine(props: {
  project: SidebarChatProject | null;
  animate: boolean;
}) {
  const [shown, setShown] = useState(props.project);
  // A row that mounts already in a project (a mode switch, a remount, a row
  // scrolled back in) shows its line at rest; only a chat moved into a
  // project while on screen grows it in.
  const [mountedInProject] = useState(props.project !== null);
  if (props.project !== null && props.project !== shown) setShown(props.project);
  const visible = props.project !== null;
  if (shown === null) return null;
  return (
    <span
      aria-hidden={!visible || undefined}
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden text-muted-foreground text-xs",
        props.animate &&
          "transition-[height,opacity] duration-(--motion-duration-base) ease-standard motion-reduce:transition-opacity",
        props.animate && !mountedInProject && "starting:h-0 starting:opacity-0",
        "group-[.state-selected]/sidebar-row:text-secondary-label",
        visible ? "h-4 opacity-100" : "h-0 opacity-0",
      )}
    >
      <ProjectFolderIcon project={shown.icon} />
      <span className="min-w-0 flex-1 truncate">{shown.name}</span>
    </span>
  );
}

/**
 * Whether Chats rows may animate a change of project. Off until the project
 * list has loaded and painted, so rows gaining their subtext as the projects
 * arrive do not all grow at once; after that only a move animates.
 */
export function useChatProjectMetaAnimates(projectsLoaded: boolean): boolean {
  const [animates, setAnimates] = useState(false);
  useEffect(() => {
    if (!projectsLoaded || animates) return;
    const frame = requestAnimationFrame(() => setAnimates(true));
    return () => cancelAnimationFrame(frame);
  }, [animates, projectsLoaded]);
  return animates;
}
