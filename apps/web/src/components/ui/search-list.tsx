"use client";

import { cva } from "class-variance-authority";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { SearchField } from "~/components/ui/search-input";

/*
 * The look of every searchable list: its search header, rows, group labels and empty state.
 *
 * Two Base UI engines drive it, and both render these parts, so a row reads the same in either:
 *
 * - `command.tsx` (Autocomplete) for free-text search where picking a row runs it: the command
 *   palette and its modes (Files, favicons), and the composer's `@`, `/` and `$` menus.
 * - `combobox.tsx` (Combobox) for popover pickers that hold a chosen value: project, repository,
 *   model, branch and the like.
 *
 * Both give the same keyboard model (arrows, Home/End, Enter, Escape, filtering as you type, the
 * highlighted row kept in view) and the same combobox/listbox roles. A row's content is built from
 * the `SearchListRow*` slots below, inside the engine's item (`CommandItem` or `ComboboxItem`):
 *
 *   <ComboboxItem value={source}>
 *     <SearchListRowIcon><BrandIcon /></SearchListRowIcon>
 *     <SearchListRowText layout="inline">
 *       <SearchListRowLabel>{source.name}</SearchListRowLabel>
 *       <SearchListRowDescription>{source.account}</SearchListRowDescription>
 *     </SearchListRowText>
 *     <SearchListRowTrailing>
 *       <SearchListRowBadge tone="warning">Needs sign-in</SearchListRowBadge>
 *     </SearchListRowTrailing>
 *   </ComboboxItem>
 */

/**
 * A row's frame, for the engine items in components/ui. `density` follows the container: a dialog
 * or the composer drawer is `comfortable`, a popover picker `compact`. `highlight` is how the
 * keyboard cursor paints: `hover` where a chosen value is painted selected and the cursor only
 * hovers, `cursor` where nothing is chosen so the cursor takes the selected fill, `none` when the
 * caller paints an `active` row itself.
 */
const searchListRowVariants = cva(
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='text-'])]:text-muted-foreground",
  {
    defaultVariants: {
      density: "compact",
      divider: false,
      highlight: "hover",
      tone: "default",
    },
    variants: {
      density: {
        compact: "py-1",
        comfortable: "py-1.5",
      },
      highlight: {
        hover: "state-hover data-selected:state-selected",
        cursor: "data-highlighted:state-selected data-selected:state-selected",
        none: "",
      },
      /** `action` is a row that does something other than pick a value, such as "Add repository": muted until hovered. */
      tone: {
        default: "",
        action: "text-muted-foreground",
      },
      /** A hairline above the row, setting an action row apart from the values. It spans the list, centered in the gap. */
      divider: {
        true: "relative mt-3 before:absolute before:-inset-x-1.5 before:-top-1.5 before:h-px before:bg-border",
        false: "",
      },
    },
  },
);

/** The search row on top of a list: the palette's tall header, or a popover's slim one with a hairline under it. */
const searchListSearchVariants = cva("min-w-0 shrink-0", {
  defaultVariants: { size: "popover" },
  variants: {
    size: {
      dialog: "px-[var(--command-shell-inset)] py-1.5",
      // Its inset matches the list's padding plus a row's, so the search icon sits on the row-icon column.
      popover: "border-b border-border px-3.5",
    },
  },
});

/** The list's padding: rows' fills sit this far in from the container's edge. */
const searchListListVariants = cva("", {
  defaultVariants: { size: "popover" },
  variants: {
    size: {
      dialog: "not-empty:scroll-py-2 not-empty:p-2",
      popover: "not-empty:scroll-py-1.5 not-empty:p-1.5",
    },
  },
});

/**
 * What a list says when nothing matches or results are on their way. `dialog` is the palette's
 * roomy centered line, `popover` a picker's, and `row` one result row tall, for a drawer that
 * should not jump in height while results come and go.
 */
const searchListEmptyVariants = cva("text-muted-foreground", {
  defaultVariants: { size: "popover" },
  variants: {
    size: {
      dialog: "py-10 text-center text-sm",
      popover: "not-empty:px-3.5 not-empty:py-3 text-center text-base sm:text-sm",
      row: "m-2 flex min-h-8 items-center px-2 text-sm sm:min-h-7",
    },
  },
});

/** A group's header: a quiet section line whose optional mark sits on the row-icon column. */
const SEARCH_LIST_GROUP_LABEL_CLASS =
  "flex min-w-0 items-center gap-2 px-2 py-1.5 font-medium text-muted-foreground text-xs";

/** A group label's content: its mark on the row-icon column, then its text. */
function SearchListGroupLabelContent(props: {
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (!props.icon) return props.children;
  return (
    <>
      <span
        aria-hidden="true"
        className="flex h-4 min-w-4 shrink-0 items-center justify-center [&>svg:not([class*='size-'])]:size-3.5"
      >
        {props.icon}
      </span>
      <span className="min-w-0 truncate">{props.children}</span>
    </>
  );
}

/** The search header around an engine's input (`CommandInput`, `ComboboxSearchInput`). */
function SearchListSearch({
  size = "popover",
  icon,
  className,
  children,
}: {
  size?: "dialog" | "popover";
  /** Replaces the search icon, as the palette's submenu back button does. */
  icon?: React.ReactNode;
  /** Classes for the field around the input (the palette adds end padding for its action label). */
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      className={searchListSearchVariants({ size })}
      data-slot={size === "popover" ? "combobox-search" : "command-search"}
    >
      <SearchField
        size={size === "dialog" ? "md" : "sm"}
        variant="bare"
        className={cn(size === "popover" && "h-9", className)}
        {...(icon ? { icon } : {})}
      >
        {children}
      </SearchField>
    </div>
  );
}

/** The empty or loading line of a list that renders its own (the palette, the composer drawer). */
function SearchListEmpty({
  size = "dialog",
  className,
  ...props
}: React.ComponentProps<"div"> & { size?: "dialog" | "popover" | "row" }) {
  return (
    <div
      className={cn(searchListEmptyVariants({ size }), className)}
      data-slot="search-list-empty"
      {...props}
    />
  );
}

/**
 * A row that is listed but cannot be picked, outside the engine's items (the palette lists
 * unavailable commands this way so they never take the keyboard cursor).
 */
function SearchListStaticRow({
  density = "comfortable",
  className,
  ...props
}: React.ComponentProps<"div"> & { density?: "compact" | "comfortable" }) {
  return (
    <div
      aria-disabled="true"
      className={cn(
        searchListRowVariants({ density, highlight: "none" }),
        "cursor-default opacity-64",
        className,
      )}
      data-slot="search-list-row"
      {...props}
    />
  );
}

/**
 * A row's leading mark: an icon, a brand logo, a favicon or a file icon. A fixed column (at least
 * 16px) so a 14px badge and a 16px icon put their labels on the same line.
 */
function SearchListRowIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 shrink-0 items-center justify-center [&>svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="search-list-row-icon"
      {...props}
    />
  );
}

/**
 * A row's text: a label and, optionally, a description. `stacked` puts the description on its own
 * line under the label (the palette); `inline` puts it after the label on one line, where it
 * truncates first (the composer menus and repository rows).
 */
function SearchListRowText({
  layout = "stacked",
  className,
  ...props
}: React.ComponentProps<"span"> & { layout?: "stacked" | "inline" }) {
  return (
    <span
      className={cn(
        "group/search-list-row-text flex min-w-0 flex-1",
        layout === "stacked" ? "flex-col" : "items-center gap-2",
        className,
      )}
      data-layout={layout}
      data-slot="search-list-row-text"
      {...props}
    />
  );
}

/**
 * A row's label, truncated to one line, in the row's own color (so an `action` row stays muted and
 * a highlighted row's foreground applies). `leading` sits before the text inside the label (a
 * status dot, a pin). Works as a `render` target: `<TooltipTrigger render={<SearchListRowLabel />}>`.
 */
function SearchListRowLabel({
  leading,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { leading?: React.ReactNode }) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)}
      data-slot="search-list-row-label"
      {...props}
    >
      {leading}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A row's secondary text: wraps under a stacked label, truncates after an inline one. */
function SearchListRowDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "min-w-0 text-muted-foreground/70 text-xs group-data-[layout=inline]/search-list-row-text:flex-1 group-data-[layout=inline]/search-list-row-text:truncate",
        className,
      )}
      data-slot="search-list-row-description"
      {...props}
    />
  );
}

/** A row's end: shortcut, badge, timestamp, check, chevron or a row menu, in that slot only. */
function SearchListRowTrailing({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ms-auto flex shrink-0 items-center gap-2", className)}
      data-slot="search-list-row-trailing"
      {...props}
    />
  );
}

/** A keyboard shortcut at a row's end. */
function SearchListRowShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

/** Quiet metadata at a row's end, such as a relative time. */
function SearchListRowMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "min-w-12 shrink-0 text-right text-muted-foreground/70 text-xs tabular-nums",
        className,
      )}
      data-slot="search-list-row-meta"
      {...props}
    />
  );
}

/**
 * A status or kind at a row's end: "Needs sign-in", "Repo", "Default". `tone` carries meaning:
 * `neutral` for a kind, `warning` for something to fix before it works, `error` for a failure.
 */
function SearchListRowBadge({
  tone = "neutral",
  className,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant" | "size"> & {
  tone?: "neutral" | "info" | "success" | "warning" | "error";
}) {
  return (
    <Badge
      // The row mutes icons that set no color; a badge's icon takes the badge's tone instead.
      className={cn("[&_svg]:text-current!", className)}
      variant={tone === "neutral" ? "secondary" : tone}
      data-slot="search-list-row-badge"
      {...props}
    />
  );
}

/** Marks the row holding a picker's chosen value. */
function SearchListRowCheck({ className, ...props }: React.ComponentProps<typeof CheckIcon>) {
  return (
    <CheckIcon
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      data-slot="search-list-row-check"
      {...props}
    />
  );
}

/** Marks a row that opens a nested list instead of running. */
function SearchListRowSubmenu({
  className,
  ...props
}: React.ComponentProps<typeof ChevronRightIcon>) {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn("-me-0.5 size-4 shrink-0 text-muted-foreground/70", className)}
      data-slot="search-list-row-submenu"
      {...props}
    />
  );
}

export {
  SEARCH_LIST_GROUP_LABEL_CLASS,
  SearchListEmpty,
  SearchListGroupLabelContent,
  SearchListRowBadge,
  SearchListRowCheck,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowMeta,
  SearchListRowShortcut,
  SearchListRowSubmenu,
  SearchListRowText,
  SearchListRowTrailing,
  SearchListSearch,
  SearchListStaticRow,
  searchListEmptyVariants,
  searchListListVariants,
  searchListRowVariants,
};
