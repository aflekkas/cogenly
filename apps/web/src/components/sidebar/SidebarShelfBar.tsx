import { ArchiveIcon, ClockIcon, LoaderIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export type SidebarShelf = "working" | "snoozed" | "settled";

interface ShelfSegment {
  readonly shelf: SidebarShelf | null;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
}

/**
 * The count bar above the search dock: the active list plus one segment per
 * shelf. Choosing a shelf opens it and closes the others; choosing the open
 * shelf (or the active segment) goes back to the active list.
 */
export function SidebarShelfBar({
  activeIcon,
  activeLabel,
  activeCount,
  workingCount,
  snoozedCount,
  settledCount,
  openShelf,
  onOpenShelf,
}: {
  activeIcon: LucideIcon;
  activeLabel: string;
  activeCount: number;
  /** Null hides the Working segment, for modes without that shelf. */
  workingCount: number | null;
  snoozedCount: number;
  settledCount: number;
  openShelf: SidebarShelf | null;
  onOpenShelf: (shelf: SidebarShelf | null) => void;
}) {
  const segments: ShelfSegment[] = [
    { shelf: null, icon: activeIcon, label: activeLabel, count: activeCount },
    ...(workingCount === null
      ? []
      : [{ shelf: "working" as const, icon: LoaderIcon, label: "Working", count: workingCount }]),
    { shelf: "snoozed", icon: ClockIcon, label: "Snoozed", count: snoozedCount },
    { shelf: "settled", icon: ArchiveIcon, label: "Settled", count: settledCount },
  ];
  return (
    <div
      role="tablist"
      aria-label="Sidebar lists"
      className="mb-2.5 flex h-9 gap-0.5 rounded-[10px] bg-(--sidebar-shelf-bar) p-0.5"
    >
      {segments.map((segment) => {
        const selected = segment.shelf === openShelf;
        const Icon = segment.icon;
        return (
          <button
            key={segment.label}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={`${segment.label} (${segment.count})`}
            title={segment.label}
            onClick={() => onOpenShelf(selected ? null : segment.shelf)}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-xs tabular-nums outline-none transition-colors duration-(--motion-duration-base) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:shrink-0",
              selected
                ? "bg-(--sidebar-shelf-selected) text-sidebar-foreground"
                : "text-(--nav-rail-muted) hover:text-sidebar-foreground",
            )}
          >
            <Icon aria-hidden />
            {segment.count}
          </button>
        );
      })}
    </div>
  );
}
