import type { ScopedProjectRef } from "@t3tools/contracts";

import { RepositoryBadge } from "./RepositoryBadge";

/**
 * A Work list group heading: a small tinted badge and the repository name in
 * monospace. Right-click opens the repository's own menu (new thread,
 * folder, settings) when it has one.
 */
export function RepositoryGroupHeading({
  name,
  projectRef,
  onContextMenu,
}: {
  name: string | null;
  projectRef: ScopedProjectRef;
  onContextMenu?:
    | ((projectRef: ScopedProjectRef, position: { x: number; y: number }) => void)
    | undefined;
}) {
  return (
    <li
      role="presentation"
      data-sidebar-group-label
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              onContextMenu(projectRef, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      className="flex h-7 list-none items-center gap-2 px-3 pt-3 font-mono text-xs text-(--sidebar-heading-foreground,var(--sidebar-muted-foreground))"
    >
      {name ? <RepositoryBadge name={name} /> : null}
      <span className="min-w-0 truncate">{name ?? "No repository"}</span>
    </li>
  );
}
