import { RepositoryBadge } from "./RepositoryBadge";

/** A Work list group heading: a small tinted badge and the repository name in monospace. */
export function RepositoryGroupHeading({ name }: { name: string | null }) {
  return (
    <li
      role="presentation"
      data-sidebar-group-label
      className="flex h-7 list-none items-center gap-2 px-3 pt-3 font-mono text-xs text-(--sidebar-heading-foreground,var(--sidebar-muted-foreground))"
    >
      {name ? <RepositoryBadge name={name} /> : null}
      <span className="min-w-0 truncate">{name ?? "No repository"}</span>
    </li>
  );
}
