import { PlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { projectContentsCount } from "../../../projectLabels/projectContents.logic";
import type {
  EnvironmentProjectLabel,
  ProjectLabelKey,
} from "../../../projectLabels/projectLabels.logic";
import { ProjectColorDot } from "../../../projectLabels/ProjectTag";
import { useProjectContents } from "../../../projectLabels/useProjectContents";

/**
 * The Projects mode list: every project across connected machines, with
 * how many Work threads, chats and agents it holds. A project opens its
 * view in the main area.
 */
export function SidebarProjectsList(props: {
  activeProjectKey: ProjectLabelKey | null;
  environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
  onOpenProject: (entry: EnvironmentProjectLabel) => void;
  onCreateProject: () => void;
}) {
  const { directory, byProject } = useProjectContents();
  if (directory.labels.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground">
        <span>No projects yet</span>
        <button
          type="button"
          onClick={props.onCreateProject}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors state-hover"
        >
          <PlusIcon className="-mx-0.5 size-3" />
          New project
        </button>
      </div>
    );
  }
  return (
    <ul aria-label="Projects" className="flex flex-col gap-1">
      {directory.labels.map((entry) => {
        const count = projectContentsCount(byProject.get(entry.key));
        const active = entry.key === props.activeProjectKey;
        const environment = props.environmentLabel(entry);
        return (
          <li key={entry.key} className="list-none">
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => props.onOpenProject(entry)}
              className={cn(
                "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active ? "state-selected" : "state-hover",
              )}
            >
              <ProjectColorDot color={entry.label.color} className="size-2.5" />
              <span className="min-w-0 flex-1 truncate">{entry.label.name}</span>
              {environment ? (
                <span className="max-w-1/3 shrink-0 truncate text-xs text-secondary-label">
                  {environment}
                </span>
              ) : null}
              {count > 0 ? (
                <span
                  className="shrink-0 text-xs tabular-nums text-secondary-label"
                  aria-label={count === 1 ? "1 item" : `${count} items`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
