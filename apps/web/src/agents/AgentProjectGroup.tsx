import type { ContextMenuItem } from "@t3tools/contracts";
import { FolderMinusIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  SIDEBAR_GROUP_START_CLASS_NAME,
  SidebarGroupHeader,
  SidebarList,
} from "~/components/sidebar/SidebarList";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import type { EnvironmentProjectLabel } from "~/projectLabels/projectLabels.logic";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";

type GroupMenuAction = "new-agent" | "toggle";

/**
 * One project's agents in the Agents list: the shared group header with the
 * project's folder in its colour (a plain folder for No project), its name and
 * a chevron, and the rows under it. The header toggles the group; right-click
 * offers New Agent in the project. The rows grow and fade open or shut and stay
 * mounted while shut, invisible and inert. Without `heading` (no agent is in a
 * project) only the rows render, as a flat list.
 */
export function AgentProjectGroup(props: {
  readonly groupKey: string;
  readonly folder: EnvironmentProjectLabel | null;
  readonly heading: boolean;
  /** Agents in the group, shown on its heading. */
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Starts the builder filed in this project; absent for No project. */
  readonly onCreate?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const name = props.folder?.label.name ?? "No project";
  const open = props.open || !props.heading;
  const openMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<GroupMenuAction>[] = [
      ...(props.onCreate
        ? [{ id: "new-agent" as const, label: `New Agent in ${name}`, icon: "message-square-plus" }]
        : []),
      {
        id: "toggle",
        label: open ? "Collapse" : "Expand",
        separatorBefore: props.onCreate !== undefined,
      },
    ];
    const clicked = await api.contextMenu.show(items, position);
    if (clicked === "new-agent") props.onCreate?.();
    else if (clicked === "toggle") props.onToggle();
  };
  return (
    <li
      className={cn("flex min-w-0 list-none flex-col", SIDEBAR_GROUP_START_CLASS_NAME)}
      data-agent-group={props.groupKey}
    >
      {props.heading ? (
        <SidebarGroupHeader
          as="div"
          data-agent-flip={`group:${props.groupKey}`}
          icon={
            props.folder ? (
              <ProjectFolderIcon color={props.folder.label.color} className="size-3.5" />
            ) : (
              // The composer's project picker marks "No project" the same way.
              <FolderMinusIcon aria-hidden className="size-3.5 shrink-0" />
            )
          }
          label={name}
          count={props.count}
          collapse={{
            open,
            onToggle: props.onToggle,
            ariaLabel: `${name}, ${open ? "collapse" : "expand"}`,
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            void openMenu({ x: event.clientX, y: event.clientY });
          }}
        />
      ) : null}
      <GroupCollapse open={open}>
        <SidebarList density="cards" aria-label={props.heading ? name : undefined}>
          {props.children}
        </SidebarList>
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
