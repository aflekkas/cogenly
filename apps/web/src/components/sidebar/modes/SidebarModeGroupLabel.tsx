import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A static group heading ("Today", a project name) with the same geometry
 * and tone as the sidebar's collapsible shelf headers, minus the toggle.
 */
export function SidebarModeGroupLabel(props: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <li
      role="presentation"
      data-sidebar-group-label
      className={cn(
        "mx-0.5 flex h-8 list-none items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/60",
        props.className,
      )}
    >
      {props.icon}
      <span className="min-w-0 shrink truncate">{props.children}</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
    </li>
  );
}
