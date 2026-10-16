import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A static group heading ("Today", a project name) with the same geometry
 * and tone as the sidebar's collapsible shelf headers, minus the toggle.
 * An optional trailing action (a project heading's settings gear) shows on
 * hover or focus with fine pointers and stays visible on touch.
 */
export function SidebarModeGroupLabel(props: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  onContextMenu?: ((event: ReactMouseEvent<HTMLLIElement>) => void) | undefined;
  className?: string;
}) {
  return (
    <li
      role="presentation"
      data-sidebar-group-label
      onContextMenu={props.onContextMenu}
      className={cn(
        "group/group-label mx-0.5 flex h-8 list-none items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60",
        props.action != null && "pr-0.5",
        props.className,
      )}
    >
      {props.icon}
      <span className="min-w-0 shrink truncate">{props.children}</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
      {props.action != null ? (
        <span className="flex shrink-0 pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:group-hover/group-label:opacity-100 pointer-fine:focus-within:opacity-100">
          {props.action}
        </span>
      ) : null}
    </li>
  );
}
