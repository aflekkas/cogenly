import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "../../lib/utils";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { ScrollArea } from "../ui/scroll-area";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

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
        "corner-glow dropdown-glass surface-raised isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl",
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

/**
 * One section of thread details (and the agent panels built from the same
 * parts): a quiet label, then its rows. Every section has the same header and
 * the same hairline above it. Pass `collapsible` for a section that can run
 * long; its header stays the same label with the shared disclosure chevron
 * after it, and the body folds with the shared disclosure motion. `meta` sits
 * after the title in the same type (a count, "1 failed").
 */
export function ThreadDetailsSection({
  headingId,
  title,
  meta,
  actions,
  separated = true,
  collapsible,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  separated?: boolean;
  collapsible?: { open: boolean; onOpenChange: (open: boolean) => void } | undefined;
}) {
  const label = (
    <>
      {title}
      {meta !== undefined && meta !== null ? (
        <span className="ms-1.5 font-normal tabular-nums">{meta}</span>
      ) : null}
    </>
  );
  return (
    <section
      {...props}
      aria-labelledby={headingId}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div className="mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5">
        <h3
          id={headingId}
          className="flex min-w-0 flex-1 text-2xs font-medium text-muted-foreground select-none"
        >
          {collapsible ? (
            <DisclosureTrigger
              open={collapsible.open}
              onClick={() => collapsible.onOpenChange(!collapsible.open)}
              className="h-8 min-w-0 flex-1"
            >
              <span className="min-w-0 truncate">{label}</span>
            </DisclosureTrigger>
          ) : (
            <span className="min-w-0 truncate">{label}</span>
          )}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {collapsible ? (
        <DisclosurePanel open={collapsible.open}>{children}</DisclosurePanel>
      ) : (
        children
      )}
    </section>
  );
}

/**
 * The one row shape inside a details section: an icon column, the label, an
 * optional muted secondary after it, and trailing meta (status, duration).
 * Pass `onClick` or `render` for a row that acts; without either it is a
 * static row with the same geometry.
 */
export function ThreadDetailsRow({
  icon,
  label,
  secondary,
  trailing,
  ...props
}: Omit<ComponentProps<typeof ThreadDetailsControl>, "children" | "part"> & {
  icon: ReactNode;
  label: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      {icon}
      <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {label}
        {secondary !== undefined && secondary !== null ? (
          <span className="font-normal text-muted-foreground"> · {secondary}</span>
        ) : null}
      </span>
      {trailing}
    </>
  );
  if (props.onClick === undefined && props.render === undefined) {
    return (
      <div
        className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, props.className)}
      >
        {content}
      </div>
    );
  }
  return (
    <ThreadDetailsControl part="row" {...props}>
      {content}
    </ThreadDetailsControl>
  );
}
