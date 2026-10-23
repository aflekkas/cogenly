import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { WorkHeroCrumb } from "~/projectLabels/projectMeta.logic";

/**
 * The Work hero's "What should we build in <project> / <repository>?", for the
 * new-Work screen (pickers) and an unwritten Work thread (plain names). It
 * holds one line while it fits; otherwise "<project> / <repository>?" moves to
 * the next line whole, never split from its "/" or "?". useHeroHeadlineMotion
 * animates that move.
 */
export function WorkHeroSentence(props: {
  readonly project: ReactNode;
  readonly repository: ReactNode;
}) {
  return (
    <>
      <span data-hero-greeting="" className="inline-block max-w-full">
        What should we build in
      </span>{" "}
      {/* One unbreakable unit; its halves truncate before it outgrows the line. */}
      <span
        data-hero-breadcrumb=""
        className="inline-flex max-w-full items-baseline whitespace-nowrap align-baseline"
      >
        {props.project}
        <span aria-hidden className="mx-[0.25em] shrink-0 text-muted-foreground/40">
          /
        </span>
        {props.repository}
        {/* Clear of the last glyph and the picker's underline. */}
        <span aria-hidden className="ms-[0.08em] shrink-0">
          ?
        </span>
      </span>
    </>
  );
}

/** A read-only half of the breadcrumb; a placeholder ("No project") reads muted. */
export function WorkHeroCrumbText(props: {
  readonly crumb: WorkHeroCrumb;
  readonly icon?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "block min-w-0 max-w-64 truncate",
        props.crumb.placeholder && "text-muted-foreground",
      )}
    >
      {props.crumb.placeholder ? null : props.icon}
      {props.crumb.text}
    </span>
  );
}
