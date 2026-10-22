import { FolderIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DisclosureChevron } from "~/components/ui/disclosure";
import type { EnvironmentProjectLabel } from "~/projectLabels/projectLabels.logic";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";

/**
 * One project's agents in the Agents list: a quiet header with the project's
 * folder in its colour (a plain folder for No project), its name and a chevron,
 * and the cards under it. The header toggles the group; the cards grow and fade
 * open or shut and stay mounted while shut, invisible and inert. Without
 * `heading` (no agent is in a project) only the cards render, as a flat list.
 */
export function AgentProjectGroup(props: {
  readonly groupKey: string;
  readonly folder: EnvironmentProjectLabel | null;
  readonly heading: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Starts the builder filed in this project; absent for No project. */
  readonly onCreate?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const name = props.folder?.label.name ?? "No project";
  const open = props.open || !props.heading;
  return (
    <li className="flex list-none flex-col" data-agent-group={props.groupKey}>
      {props.heading ? (
        <div
          data-agent-flip={`group:${props.groupKey}`}
          className="group/agent-group mx-0.5 flex h-8 items-center gap-0.5 text-xs font-medium text-sidebar-muted-foreground/60"
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${name}, ${open ? "collapse" : "expand"}`}
            onClick={props.onToggle}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-(--motion-duration-fast) ease-standard hover:text-sidebar-muted-foreground focus-visible:text-sidebar-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
          >
            {props.folder ? (
              <ProjectFolderIcon color={props.folder.label.color} className="size-3.5" />
            ) : (
              <FolderIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 shrink truncate">{name}</span>
            <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
            <DisclosureChevron open={open} />
          </button>
          {props.onCreate ? (
            <span className="flex shrink-0 pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:duration-(--motion-duration-fast) pointer-fine:group-hover/agent-group:opacity-100 pointer-fine:focus-within:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={`New agent in ${name}`}
                      onClick={props.onCreate}
                    />
                  }
                >
                  <PlusIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">New agent in {name}</TooltipPopup>
              </Tooltip>
            </span>
          ) : (
            // Holds the add button's place so every group's chevron lines up.
            <span aria-hidden className="size-7 shrink-0 sm:size-6" />
          )}
        </div>
      ) : null}
      <GroupCollapse open={open}>
        <ul aria-label={props.heading ? name : undefined} className="flex flex-col gap-0.5">
          {props.children}
        </ul>
      </GroupCollapse>
    </li>
  );
}

/**
 * A group's cards, growing and fading open or shut over the base motion
 * (`.agent-group-collapse` in agents.css). Clipped only while moving or shut,
 * so a card gliding in from another group is never cut off at the edge.
 */
function GroupCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [moving, setMoving] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setMoving(true);
  }
  // A transition that never runs (a hidden tab) still settles.
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setMoving(false), 400);
    return () => clearTimeout(timer);
  }, [moving]);
  return (
    <div
      inert={!open}
      className="agent-group-collapse"
      data-closed={open ? undefined : ""}
      data-moving={moving ? "" : undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "opacity") {
          setMoving(false);
        }
      }}
    >
      <div>{children}</div>
    </div>
  );
}
