import type {
  ComponentProps,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { type SidebarLayout, useSidebarLayout } from "~/appearancePreferences";
import { cn } from "~/lib/utils";
import { DisclosureChevron, DisclosurePanel } from "../ui/disclosure";

/**
 * The sidebar's shared list pieces. Every tab (Chats, Work, Agents, Projects,
 * search results) builds its column from these, so spacing, type, hover and
 * selected states, truncation and collapse read the same everywhere:
 *
 * - `SidebarList` — the list itself, reading down from the search dock above
 *   it, or in the bottom sidebar layout stacked up against the dock below it;
 *   it fills the column when it `grow`s (`sidebarFillClassName`).
 * - `SidebarGroupHeader` — a group's heading: optional icon or badge, a label
 *   that truncates, a hairline, and a disclosure chevron when it collapses.
 * - `SidebarFoldRow` — a row under a collapsible heading, which folds with it.
 * - `sidebarRowClassName` / `SidebarRowSubtitle` — a row: one line (32px) or a
 *   title with a muted second line (40px). Chats are rows.
 * - `SidebarCardItem` / `sidebarCardClassName` / `SidebarCardBody` and its
 *   `SidebarCardLine`s — a card: Work's, Agents' and Projects' items, which
 *   carry live status and actions. Two lines (64px) or three (88px) inside
 *   12px insets; Work and Agents sort by drag (`SidebarSortable`).
 * - `SidebarListEmptyState` (its own file) — one quiet line for a list with
 *   nothing in it.
 * - `SidebarShelfBar` / `SidebarSegmentBar` (their own file) — the count bar
 *   under the search dock, the same in Work, Agents and Projects.
 *
 * Spacing comes from three values in index.css: rows sit
 * `--sidebar-row-gap` (4px) apart, cards `--sidebar-card-gap` (8px), and a
 * heading after other items takes `--sidebar-group-gap` (8px) more above it.
 * A heading is 4px from its first item in every mode. Don't hand-roll gaps,
 * margins or heights on list items; use these pieces.
 *
 * Nothing in a row may be wider than the column: every text run truncates
 * (`truncate`, `fade-truncate` or `PanOnHoverText`) inside a `min-w-0` box, and
 * the scroll viewport clips sideways as a backstop (see `SidebarContent`).
 */

/**
 * A sidebar column that fills the rest of the scroll area: its items read
 * down from the top, or in the bottom layout stack up against the dock below.
 */
export function sidebarFillClassName(layout: SidebarLayout): string {
  return cn("flex-1", layout === "bottom" && "justify-end");
}

export function SidebarList({
  density = "rows",
  grow = false,
  className,
  ...props
}: ComponentProps<"ul"> & {
  /** Rows sit --sidebar-row-gap apart; cards carry their own gap (`SidebarCardItem`). */
  density?: "rows" | "cards";
  /** Fill the rest of the column, so an empty state centres in it. */
  grow?: boolean;
}) {
  const layout = useSidebarLayout();
  return (
    <ul
      {...props}
      className={cn(
        "relative flex min-w-0 flex-col",
        density === "rows" && "gap-(--sidebar-row-gap)",
        grow && sidebarFillClassName(layout),
        className,
      )}
    />
  );
}

/**
 * The space above a group's start (its heading, or the item holding it) when
 * other items come before it: a heading sits nearer its own items.
 */
export const SIDEBAR_GROUP_START_CLASS_NAME = "not-first:mt-(--sidebar-group-gap)";

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
 * group's actions live (no inline buttons). The group's rows sit in
 * `SidebarFoldRow`s, which fold shut and open with the chevron.
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
        // Inside its group's own item, that item takes the group's space.
        as === "li" && SIDEBAR_GROUP_START_CLASS_NAME,
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

/**
 * One row under a collapsible `SidebarGroupHeader`. Folding the group closes
 * the row with the shared disclosure motion (height and opacity, `ui/disclosure`)
 * instead of removing it, so the rows below glide rather than jump, and a row
 * that stays open (the open thread) moves with them without re-popping. The
 * row is still a direct child of the list for its motion and drag, and it
 * carries its own share of the list's gap: shut, it takes no room at all.
 * Must follow another item (its heading), as its negative margin assumes one.
 */
export function SidebarFoldRow({
  open,
  density = "rows",
  className,
  children,
  ...props
}: Omit<ComponentProps<"li">, "children"> & {
  open: boolean;
  /** The list's density, whose gap this row carries. */
  density?: "rows" | "cards";
  children: ReactNode;
}) {
  return (
    <li
      {...props}
      className={cn(
        "min-w-0 list-none",
        density === "rows" && "-mt-(--sidebar-row-gap)",
        className,
      )}
    >
      <DisclosurePanel open={open}>
        <ul role="presentation" className={cn(density === "rows" && "pt-(--sidebar-row-gap)")}>
          {children}
        </ul>
      </DisclosurePanel>
    </li>
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
  /** The row holds an unsent draft (`SIDEBAR_DRAFT_CLASS_NAME`). */
  readonly draft?: boolean;
  readonly className?: string | false | null | undefined;
}): string {
  return cn(
    "group/sidebar-row relative flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left",
    ROW_FOCUS_CLASS_NAME,
    options.lines === 2 ? "h-10" : "h-8",
    options.selected ? "state-selected" : "state-hover",
    options.draft && SIDEBAR_DRAFT_CLASS_NAME,
    options.className,
  );
}

/**
 * Any row or card holding an unsent draft (a new-thread draft, or a thread
 * with text left in its composer): a faint warm wash that carries through
 * hover and selection. Its title takes `SIDEBAR_DRAFT_TITLE_CLASS_NAME`, the
 * foreground with a hint of warmth, in place of the resting/hover tones.
 */
export const SIDEBAR_DRAFT_CLASS_NAME = "sidebar-draft";
export const SIDEBAR_DRAFT_TITLE_CLASS_NAME =
  "text-[color-mix(in_srgb,var(--warning-foreground)_22%,var(--foreground))]";

/** The content-visibility placeholder height that matches a row, so offscreen rows never shift the list. */
export function sidebarRowIntrinsicSizeClassName(lines: 1 | 2): string {
  return lines === 2 ? "[contain-intrinsic-size:auto_40px]" : "[contain-intrinsic-size:auto_32px]";
}

/** A card's surface without its tones; `sidebarCardClassName` adds them. */
export const SIDEBAR_CARD_CLASS_NAME = cn(
  "group/sidebar-row sidebar-row-motion relative w-full min-w-0 cursor-pointer overflow-hidden rounded-rail text-left",
  ROW_FOCUS_CLASS_NAME,
);

/** The card's resting tone: the raised card surface over the column. */
export const SIDEBAR_CARD_REST_CLASS_NAME = "state-hover bg-(--sidebar-card)";

/**
 * A card's surface: selected (the open item, a multi-selection or an open
 * menu) or resting on the card fill. `draft` adds the draft wash. Callers
 * with their own resting text tone pass it in `className`.
 */
export function sidebarCardClassName(options: {
  readonly selected: boolean;
  readonly draft?: boolean;
  readonly className?: string | false | null | undefined;
}): string {
  return cn(
    SIDEBAR_CARD_CLASS_NAME,
    options.draft && SIDEBAR_DRAFT_CLASS_NAME,
    options.selected
      ? "state-selected"
      : cn(SIDEBAR_CARD_REST_CLASS_NAME, "text-sidebar-foreground"),
    options.className,
  );
}

type SidebarCardLines = 2 | 3;

// 12px insets around 20px lines 4px apart, the last a 16px meta line.
const cardBodyHeight: Record<SidebarCardLines, string> = { 2: "h-16", 3: "h-[5.5rem]" };
// The body plus the card's gap, so offscreen cards never shift the list.
const cardIntrinsicSize: Record<SidebarCardLines, string> = {
  2: "[contain-intrinsic-size:auto_72px]",
  3: "[contain-intrinsic-size:auto_96px]",
};

/**
 * A card's list item: it carries half the card gap above and below, so cards
 * sit `--sidebar-card-gap` apart and 4px from a heading, and skips painting
 * while offscreen at the height its `lines` give it.
 */
export function SidebarCardItem({
  lines = 3,
  className,
  ...props
}: ComponentProps<"li"> & { lines?: SidebarCardLines }) {
  return (
    <li
      {...props}
      className={cn(
        "min-w-0 list-none py-(--sidebar-card-item-padding) [content-visibility:auto]",
        cardIntrinsicSize[lines],
        className,
      )}
    />
  );
}

/**
 * A card's content box inside its surface: 12px insets around `lines`
 * `SidebarCardLine`s (a label/status line, a title, a meta line). Content that
 * is shorter than the lines (an agent's face beside its name and reply) is
 * centred in the same height, so every card in a list has the same pitch.
 */
export function SidebarCardBody({
  lines = 3,
  className,
  ...props
}: ComponentProps<"div"> & { lines?: SidebarCardLines }) {
  return (
    <div
      {...props}
      className={cn(
        "relative z-10 flex min-w-0 flex-col justify-center px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
        cardBodyHeight[lines],
        className,
      )}
    />
  );
}

const cardLineClassName = {
  /** Where it runs or what it is, with the status and hover actions at the end. */
  head: "flex h-5 min-w-0 items-center gap-1.5",
  /** The title. */
  title: "mt-1 flex h-5 min-w-0 items-center gap-1.5",
  /** Muted detail: branch, machine, counts. */
  meta: "mt-1 flex h-4 min-w-0 items-center gap-1.5 text-xs transition-colors duration-(--motion-duration-base) motion-reduce:transition-none",
} as const;

const cardMetaTones = {
  /** Work's: barely there at rest (#2b2c2e on the card), a step up when selected. */
  faint: "text-foreground/12 group-[.state-selected]/sidebar-row:text-foreground/23",
  /** Readable detail, as on a row's second line. */
  muted: "text-muted-foreground group-[.state-selected]/sidebar-row:text-secondary-label",
} as const;

/** One of a card's lines, in the order head, title, meta. */
export function SidebarCardLine({
  line,
  tone = "muted",
  className,
  ...props
}: ComponentProps<"div"> & {
  line: keyof typeof cardLineClassName;
  /** The meta line's tone. */
  tone?: keyof typeof cardMetaTones;
}) {
  return (
    <div
      {...props}
      className={cn(cardLineClassName[line], line === "meta" && cardMetaTones[tone], className)}
    />
  );
}

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
