import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

/**
 * The one "nothing here" state. It fades in place on mount, opacity only.
 *
 * Sizes follow where it sits, not how important it is:
 * - `inline`: a list or card section with nothing in it. One muted line,
 *   left-aligned and padded like the rows it stands in for, with an optional
 *   small glyph before it and an optional small action at the row's end. No
 *   title. Compose `EmptyMedia`, `EmptyDescription` and `EmptyContent`
 *   directly; settings and project cards reach it through `SettingsEmpty`.
 * - `sm`: a whole panel, popover, dialog or sidebar list. Centred, muted glyph,
 *   small title.
 * - `default`: a whole pane.
 * - `hero`: a first-run route with a single headline.
 *
 * The centred sizes take whatever space the parent gives them (`flex-1` fills a
 * flex column) and sit optically centred, like `SidebarListEmptyState`: unequal
 * spacers (44% above, 56% below) lift them about 6% above the true centre.
 * Compose them from the slots; the slots read the size from the root.
 */
const emptyVariants = cva("group/empty flex min-w-0 reveal-motion", {
  defaultVariants: { size: "default" },
  variants: {
    size: {
      inline: "flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 text-start sm:px-4",
      sm: "flex-1 flex-col items-center px-6 py-8 text-balance text-center before:grow-11 after:grow-14",
      default:
        "flex-1 flex-col items-center p-6 text-balance text-center before:grow-11 after:grow-14 md:p-12",
      hero: "flex-1 flex-col items-center p-6 text-balance text-center before:grow-11 after:grow-14 md:p-12",
    },
  },
});

function Empty({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyVariants>) {
  return (
    <div
      className={cn(emptyVariants({ size }), className)}
      data-slot="empty"
      data-size={size}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full max-w-md flex-col items-center text-center group-data-[size=hero]/empty:max-w-2xl group-data-[size=sm]/empty:max-w-xs",
        className,
      )}
      data-slot="empty-header"
      {...props}
    />
  );
}

/** The glyph above the title (or before the line, `inline`): a bare icon, or a mascot that sizes itself. */
function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "mb-4 flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-7 group-data-[size=sm]/empty:mb-2.5 group-data-[size=sm]/empty:opacity-65 group-data-[size=sm]/empty:[&_svg:not([class*='size-'])]:size-5 group-data-[size=inline]/empty:mb-0 group-data-[size=inline]/empty:opacity-65 group-data-[size=inline]/empty:[&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      data-slot="empty-media"
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "font-semibold text-foreground text-xl group-data-[size=hero]/empty:text-2xl sm:group-data-[size=hero]/empty:text-3xl group-data-[size=sm]/empty:font-medium group-data-[size=sm]/empty:text-sm",
        className,
      )}
      data-slot="empty-title"
      {...props}
    />
  );
}

/** The muted copy under the title; for `inline`, the one line itself. */
function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-sm group-data-[size=sm]/empty:text-xs group-data-[size=sm]/empty:leading-relaxed group-data-[size=inline]/empty:min-w-0 group-data-[size=inline]/empty:flex-1 group-data-[size=inline]/empty:text-xs [&>a]:link [[data-slot=empty-title]+&]:mt-1 [[data-slot=empty-description]+&]:mt-1",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

/**
 * Actions or extra content under the copy, or at the row's end for `inline`
 * (one `xs` button there). Lay several buttons out in a row with a parent.
 */
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-5 flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm group-data-[size=sm]/empty:mt-3 group-data-[size=sm]/empty:gap-2 group-data-[size=inline]/empty:mt-0 group-data-[size=inline]/empty:w-auto group-data-[size=inline]/empty:shrink-0 group-data-[size=inline]/empty:flex-row group-data-[size=inline]/empty:gap-2",
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
