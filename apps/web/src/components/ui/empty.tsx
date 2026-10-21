import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

/**
 * The one "nothing here" state: an optional glyph, a title, an optional
 * description, then any actions, in whatever space the parent gives it
 * (`flex-1` fills a flex column). Like `SidebarListEmptyState`, it sits optically
 * centred: unequal spacers (44% above, 56% below) lift it about 6% above the
 * true centre of the free space. It fades in place on mount, opacity only.
 *
 * Sizes follow where it sits, not how important it is:
 * - `sm`: panels, popovers, dialogs and sidebar lists. Muted glyph, small title.
 * - `default`: a whole pane or settings section. The Agents empty state.
 * - `hero`: a first-run route with a single headline.
 *
 * Compose it from the slots; the slots read the size from the root.
 */
const emptyVariants = cva(
  "group/empty flex min-w-0 flex-1 flex-col items-center text-balance text-center reveal-motion before:grow-11 after:grow-14",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        sm: "px-6 py-8",
        default: "p-6 md:p-12",
        hero: "p-6 md:p-12",
      },
    },
  },
);

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

/** The glyph above the title: a bare icon, or a mascot that sizes itself. */
function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "mb-4 flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-7 group-data-[size=sm]/empty:mb-2.5 group-data-[size=sm]/empty:opacity-65 group-data-[size=sm]/empty:[&_svg:not([class*='size-'])]:size-5",
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

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      className={cn(
        "text-muted-foreground text-sm group-data-[size=sm]/empty:text-xs group-data-[size=sm]/empty:leading-relaxed [&>a]:link [[data-slot=empty-title]+&]:mt-1 [[data-slot=empty-description]+&]:mt-1",
        className,
      )}
      data-slot="empty-description"
      {...props}
    />
  );
}

/** Actions or extra content under the copy. Lay several buttons out in a row with a parent. */
function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-5 flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm group-data-[size=sm]/empty:mt-3 group-data-[size=sm]/empty:gap-2",
        className,
      )}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
