import { BellDotIcon, CircleCheckIcon, ClockIcon, type LucideIcon } from "lucide-react";

import { useSidebarLayout } from "~/appearancePreferences";
import { cn } from "~/lib/utils";
import { sidebarDockPopupSide } from "./SidebarSearchDock";
import { isSegmentSelectable } from "./sidebarSegments.logic";
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

/** What an empty filter's segment says instead of opening onto nothing. */
export const SIDEBAR_SHELF_EMPTY_LABELS: Record<SidebarShelf, string> = {
  attention: "Nothing needs you",
  snoozed: "Nothing snoozed",
  settled: "Nothing settled",
};

/** Counts past two digits read "99+"; the tooltip and label keep the number. */
export function formatSidebarShelfCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

interface ShelfSegment extends SidebarSegment {
  readonly shelf: SidebarShelf | null;
}

export interface SidebarSegment {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  /** Lit in the brand accent while non-zero. */
  readonly highlight?: boolean;
  /** The count is not known yet (loading or reconnecting); shows an ellipsis. */
  readonly pending?: boolean;
  /** The tooltip while the count is zero, when the segment cannot be chosen. */
  readonly emptyLabel: string;
}

/**
 * The count bar under the search dock, shared by every mode's filters (Work's
 * four, Agents' two). It spans the dock's width like the search field above
 * it, splits that width into equal segments, and slides one highlight between
 * them. A segment with nothing in it dims and cannot be chosen, so a filter
 * never opens onto an empty list; callers resolve the selection with
 * `useSegmentSelection`, which falls back once the chosen one runs out.
 */
export function SidebarSegmentBar({
  segments,
  selectedIndex,
  onSelect,
  ariaLabel = "Sidebar lists",
}: {
  segments: ReadonlyArray<SidebarSegment>;
  selectedIndex: number;
  onSelect: (index: number) => void;
  ariaLabel?: string;
}) {
  const layout = useSidebarLayout();
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "relative isolate flex h-9 w-full rounded-rail bg-(--sidebar-shelf-bar) p-0.5",
        // Under the search dock, or over it in the bottom layout.
        layout === "bottom" ? "mb-2.5" : "mt-2.5",
      )}
    >
      {/* One highlight, one segment wide, glides to the selected segment. */}
      <span
        aria-hidden
        className="corner-glow absolute inset-y-0.5 left-0.5 -z-10 rounded-lg [--corner-glow:0%] [--corner-glow-top:0.8%] [--surface-edge:rgb(255_255_255/1.2%)] border border-(--surface-edge,transparent) bg-(--sidebar-shelf-selected) shadow-(--surface-halo,none) transition-transform duration-(--motion-duration-base) ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${segments.length})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {segments.map((segment, index) => {
        const selected = index === selectedIndex;
        const Icon = segment.icon;
        const label = `${segment.label} (${segment.pending ? "…" : segment.count})`;
        const selectable = isSegmentSelectable(segment.pending ? null : segment.count);
        return (
          <Tooltip key={segment.label}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={label}
                  aria-disabled={selectable ? undefined : true}
                  // A click never parks focus on the segment, so no focus ring
                  // lingers after it (a later keypress would otherwise make the
                  // ring show over the filled highlight). Keyboard focus still
                  // gets the ring.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (selectable) onSelect(index);
                  }}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-xs tabular-nums outline-none transition-[color,opacity] duration-(--motion-duration-base) ease-standard focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:shrink-0",
                    // Equal-width segments, so a count changing length never shifts the row.
                    "flex-1 basis-0",
                    selected
                      ? "text-sidebar-foreground"
                      : selectable
                        ? "text-(--sidebar-shelf-muted,var(--nav-rail-muted)) hover:text-sidebar-foreground"
                        : "cursor-default text-(--sidebar-shelf-muted,var(--nav-rail-muted)) opacity-45",
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
                {segment.pending ? "…" : formatSidebarShelfCount(segment.count)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side={sidebarDockPopupSide(layout)}>
              {selectable ? label : segment.emptyLabel}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The count bar under the search dock: all tasks, the ones that need the
 * user, then one segment per shelf. Choosing a filter opens it and closes the
 * others; choosing the open one (or the first segment) goes back to all tasks.
 */
export function SidebarShelfBar({
  activeIcon,
  activeLabel,
  activeEmptyLabel,
  activeCount,
  attentionCount,
  snoozedCount,
  settledCount,
  openShelf,
  onOpenShelf,
}: {
  activeIcon: LucideIcon;
  activeLabel: string;
  activeEmptyLabel: string;
  activeCount: number;
  attentionCount: number;
  snoozedCount: number;
  settledCount: number;
  openShelf: SidebarShelf | null;
  onOpenShelf: (shelf: SidebarShelf | null) => void;
}) {
  const segments: ShelfSegment[] = [
    {
      shelf: null,
      icon: activeIcon,
      label: activeLabel,
      count: activeCount,
      emptyLabel: activeEmptyLabel,
    },
    {
      shelf: "attention",
      icon: SIDEBAR_SHELF_ICONS.attention,
      label: SIDEBAR_SHELF_LABELS.attention,
      emptyLabel: SIDEBAR_SHELF_EMPTY_LABELS.attention,
      count: attentionCount,
      highlight: true,
    },
    {
      shelf: "snoozed",
      icon: SIDEBAR_SHELF_ICONS.snoozed,
      label: SIDEBAR_SHELF_LABELS.snoozed,
      emptyLabel: SIDEBAR_SHELF_EMPTY_LABELS.snoozed,
      count: snoozedCount,
    },
    {
      shelf: "settled",
      icon: SIDEBAR_SHELF_ICONS.settled,
      label: SIDEBAR_SHELF_LABELS.settled,
      emptyLabel: SIDEBAR_SHELF_EMPTY_LABELS.settled,
      count: settledCount,
    },
  ];
  const selectedIndex = Math.max(
    0,
    segments.findIndex((segment) => segment.shelf === openShelf),
  );
  return (
    <SidebarSegmentBar
      segments={segments}
      selectedIndex={selectedIndex}
      // Choosing the open filter (or the first segment) goes back to all tasks.
      onSelect={(index) => {
        const segment = segments[index];
        if (!segment) return;
        onOpenShelf(index === selectedIndex ? null : segment.shelf);
      }}
    />
  );
}
