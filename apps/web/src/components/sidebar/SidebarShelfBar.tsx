import { BellDotIcon, CircleCheckIcon, ClockIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Work's filters past the first: tasks waiting on the user, then the two shelves. */
export type SidebarShelf = "attention" | "snoozed" | "settled";

/** Each filter's glyph, shared by its count-bar segment and its empty state. */
export const SIDEBAR_SHELF_ICONS: Record<SidebarShelf, LucideIcon> = {
  attention: BellDotIcon,
  snoozed: ClockIcon,
  settled: CircleCheckIcon,
};

export const SIDEBAR_SHELF_LABELS: Record<SidebarShelf, string> = {
  attention: "Needs attention",
  snoozed: "Snoozed",
  settled: "Settled",
};

/** Counts past two digits read "99+"; the tooltip and label keep the number. */
export function formatSidebarShelfCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

interface ShelfSegment {
  readonly shelf: SidebarShelf | null;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  /** Lit in the brand accent while non-zero. */
  readonly highlight?: boolean;
}

/**
 * The count bar above the search dock: all tasks, the ones that need the
 * user, then one segment per shelf. Choosing a filter opens it and closes the
 * others; choosing the open one (or the first segment) goes back to all tasks.
 */
export function SidebarShelfBar({
  activeIcon,
  activeLabel,
  activeCount,
  attentionCount,
  snoozedCount,
  settledCount,
  openShelf,
  onOpenShelf,
}: {
  activeIcon: LucideIcon;
  activeLabel: string;
  activeCount: number;
  attentionCount: number;
  snoozedCount: number;
  settledCount: number;
  openShelf: SidebarShelf | null;
  onOpenShelf: (shelf: SidebarShelf | null) => void;
}) {
  const segments: ShelfSegment[] = [
    { shelf: null, icon: activeIcon, label: activeLabel, count: activeCount },
    {
      shelf: "attention",
      icon: SIDEBAR_SHELF_ICONS.attention,
      label: SIDEBAR_SHELF_LABELS.attention,
      count: attentionCount,
      highlight: true,
    },
    {
      shelf: "snoozed",
      icon: SIDEBAR_SHELF_ICONS.snoozed,
      label: SIDEBAR_SHELF_LABELS.snoozed,
      count: snoozedCount,
    },
    {
      shelf: "settled",
      icon: SIDEBAR_SHELF_ICONS.settled,
      label: SIDEBAR_SHELF_LABELS.settled,
      count: settledCount,
    },
  ];
  const selectedIndex = Math.max(
    0,
    segments.findIndex((segment) => segment.shelf === openShelf),
  );
  return (
    <div
      role="tablist"
      aria-label="Sidebar lists"
      className="relative isolate mb-2.5 flex h-9 rounded-rail bg-(--sidebar-shelf-bar) p-0.5"
    >
      {/* One highlight slides between the equal-width segments. */}
      <span
        aria-hidden
        className="corner-glow absolute inset-y-0.5 left-0.5 -z-10 rounded-lg [--corner-glow:0%] [--corner-glow-top:0.8%] [--surface-edge:rgb(255_255_255/1.2%)] border border-(--surface-edge,transparent) bg-(--sidebar-shelf-selected) shadow-(--surface-halo,none) transition-transform duration-(--motion-duration-slow) ease-standard motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${segments.length})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {segments.map((segment) => {
        const selected = segment.shelf === openShelf;
        const Icon = segment.icon;
        const label = `${segment.label} (${segment.count})`;
        return (
          <Tooltip key={segment.label}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={label}
                  // A click never parks focus on the segment, so no focus ring
                  // lingers after it (a later keypress would otherwise make the
                  // ring show over the filled highlight). Keyboard focus still
                  // gets the ring.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onOpenShelf(selected ? null : segment.shelf)}
                  className={cn(
                    // Equal-width segments, so a count changing length never shifts the row.
                    "flex min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-xs tabular-nums outline-none transition-colors duration-(--motion-duration-base) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:shrink-0",
                    selected
                      ? "text-sidebar-foreground"
                      : "text-(--sidebar-shelf-muted,var(--nav-rail-muted)) hover:text-sidebar-foreground",
                  )}
                />
              }
            >
              <Icon aria-hidden />
              <span
                className={cn(
                  "transition-colors duration-(--motion-duration-base) motion-reduce:transition-none",
                  segment.highlight && segment.count > 0 && "font-medium text-brand-accent",
                )}
              >
                {formatSidebarShelfCount(segment.count)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
