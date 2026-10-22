import type {
  ComponentProps,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { DisclosureChevron } from "../ui/disclosure";

/**
 * The sidebar's shared list pieces. Every tab (Chats, Work, Agents, Projects,
 * search results) builds its column from these, so spacing, type, hover and
 * selected states, truncation and collapse read the same everywhere:
 *
 * - `SidebarList` — the list itself, stacked up from the bottom against the
 *   search dock when it `grow`s.
 * - `SidebarGroupHeader` — a group's heading: optional icon or badge, a label
 *   that truncates, a hairline, and a disclosure chevron when it collapses.
 * - `sidebarRowClassName` / `SidebarRowSubtitle` — a row: one line (32px) or a
 *   title with a muted second line (44px). Chats, Agents and Projects are rows.
 * - `SIDEBAR_CARD_CLASS_NAME` — Work's cards, which carry live status and
 *   actions, share the rows' focus ring, truncation and selected state.
 * - `SidebarListEmptyState` (its own file) — one quiet line for a list with
 *   nothing in it.
 *
 * Nothing in a row may be wider than the column: every text run truncates
 * (`truncate`, `fade-truncate` or `PanOnHoverText`) inside a `min-w-0` box, and
 * the scroll viewport clips sideways as a backstop (see `SidebarContent`).
 */

export function SidebarList({
  density = "rows",
  grow = false,
  className,
  ...props
}: ComponentProps<"ul"> & {
  /** Rows sit 4px apart; Work's cards carry their own 4px padding, so 2px. */
  density?: "rows" | "cards";
  /** Fill the column and stack from the bottom, against the search dock. */
  grow?: boolean;
}) {
  return (
    <ul
      {...props}
      className={cn(
        "relative flex min-w-0 flex-col",
        density === "cards" ? "gap-0.5" : "gap-1",
        grow && "flex-1 justify-end",
        className,
      )}
    />
  );
}

// T3's section tones: muted at rest, info for states like Snoozed.
const headerTones = {
  muted: { label: "text-sidebar-muted-foreground/60", line: "bg-sidebar-border/60" },
  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },
} as const;

const headerContentClassName = "flex h-full min-w-0 flex-1 items-center gap-2 px-2";

/**
 * A section heading in a sidebar list ("Today", an Agents project, Snoozed),
 * after T3's collapsible sections: label, "(N)" count, a hairline, and with
 * `collapse` a disclosure chevron, the whole heading being the button; without,
 * it is a static label. The count updates with the rows it counts and stays
 * visible while the group is shut. Right-click goes to `onContextMenu`, where a
 * group's actions live (no inline buttons). Collapsing hides the group's rows
 * from the flat list; the list's own motion fades them out while the rows
 * below glide up (opacity only under reduced motion).
 */
export function SidebarGroupHeader({
  label,
  count,
  icon,
  mono = false,
  tone = "muted",
  collapse,
  onContextMenu,
  as = "li",
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "children" | "onContextMenu"> & {
  label: ReactNode;
  /** How many rows the group holds, shown as "(N)" after the label. */
  count?: number | undefined;
  /** A leading glyph or badge, sized by the caller (size-3.5 icons). */
  icon?: ReactNode;
  /** Code names (repositories) read in monospace. */
  mono?: boolean;
  tone?: keyof typeof headerTones;
  collapse?:
    | {
        readonly open: boolean;
        readonly onToggle: () => void;
        /** Spoken name for the toggle; defaults to the label. */
        readonly ariaLabel?: string;
        readonly testId?: string;
      }
    | undefined;
  onContextMenu?: ((event: ReactMouseEvent<HTMLElement>) => void) | undefined;
  /** "div" when the heading sits inside its group's own list item. */
  as?: "li" | "div";
  className?: string;
}) {
  const Tag = as;
  const tones = headerTones[tone];
  const content = (
    <>
      {icon}
      <span className={cn("min-w-0 shrink truncate", mono && "font-mono font-normal")}>
        {label}
      </span>
      {count !== undefined ? <span className="-ms-1 shrink-0 tabular-nums">({count})</span> : null}
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones.line)} />
    </>
  );
  return (
    <Tag
      {...rest}
      role={as === "li" && !collapse ? "presentation" : undefined}
      data-sidebar-group-label=""
      onContextMenu={onContextMenu}
      className={cn(
        "mx-0.5 flex h-8 min-w-0 list-none items-center text-xs font-medium",
        tones.label,
        className,
      )}
    >
      {collapse ? (
        <button
          type="button"
          aria-expanded={collapse.open}
          aria-label={collapse.ariaLabel}
          data-testid={collapse.testId}
          onClick={collapse.onToggle}
          className={cn(
            headerContentClassName,
            "group/disclosure cursor-pointer rounded-md text-left select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          )}
        >
          {content}
          <DisclosureChevron open={collapse.open} />
        </button>
      ) : (
        <span className={headerContentClassName}>{content}</span>
      )}
    </Tag>
  );
}

const ROW_FOCUS_CLASS_NAME =
  "outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * A sidebar row's surface: one line, or two with a `SidebarRowSubtitle`.
 * `selected` covers the open item, a multi-selection and an open context menu.
 * Rows are `group/sidebar-row`, so their parts can follow hover and selection.
 */
export function sidebarRowClassName(options: {
  readonly selected: boolean;
  readonly lines?: 1 | 2;
  readonly className?: string | false | null | undefined;
}): string {
  return cn(
    "group/sidebar-row relative flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left",
    ROW_FOCUS_CLASS_NAME,
    options.lines === 2 ? "h-11" : "h-8",
    options.selected ? "state-selected" : "state-hover",
    options.className,
  );
}

/** The content-visibility placeholder height that matches a row, so offscreen rows never shift the list. */
export function sidebarRowIntrinsicSizeClassName(lines: 1 | 2): string {
  return lines === 2 ? "[contain-intrinsic-size:auto_44px]" : "[contain-intrinsic-size:auto_32px]";
}

/** A Work card's surface (callers add the selected and resting tones). */
export const SIDEBAR_CARD_CLASS_NAME = cn(
  "group/sidebar-row sidebar-row-motion relative w-full min-w-0 cursor-pointer overflow-hidden rounded-rail text-left",
  ROW_FOCUS_CLASS_NAME,
);

/** A row's muted second line; it brightens a step while the row is selected. */
export function SidebarRowSubtitle({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      className={cn(
        "flex h-4 min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground transition-colors duration-(--motion-duration-fast) ease-standard group-[.state-selected]/sidebar-row:text-secondary-label motion-reduce:transition-none",
        className,
      )}
    />
  );
}
