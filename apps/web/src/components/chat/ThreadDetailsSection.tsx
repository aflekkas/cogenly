import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";

/** The raised card behind thread details; content scrolls inside it when it outgrows its height. */
export function ThreadDetailsSurface({
  floating = false,
  contentRef,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { floating?: boolean; contentRef?: Ref<HTMLDivElement> }) {
  return (
    <div
      {...props}
      className={cn(
        "dropdown-glass surface-raised isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-3xl",
        floating && "surface-raised-floating",
        floating && "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
        className,
      )}
    >
      <ScrollArea scrollFade className="min-h-0">
        <div ref={contentRef}>{children}</div>
      </ScrollArea>
    </div>
  );
}

/** Sections share header and content insets in both the sidebar and popover. */
export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
