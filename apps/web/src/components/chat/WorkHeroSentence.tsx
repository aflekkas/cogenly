import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { WorkHeroCrumb } from "~/projectLabels/projectMeta.logic";

/**
 * The Work hero's "What should we build in <project> / <repository>?", for the
 * new-Work screen (pickers) and an unwritten Work thread (plain names). Where
 * it breaks depends on the pane's width alone, never on the names, so picking
 * a project never rewraps it: a narrower pane puts "<project> /
 * <repository>?" on a line of its own, whole; a wider one always fits the
 * sentence on one line, since each name truncates at 16rem. Each part is a
 * `data-hero-piece`, so useHeroHeadlineMotion can glide it when a name
 * changes or the pane crosses the break, and crossfade a changed name.
 */
export function WorkHeroSentence(props: {
  readonly project: ReactNode;
  readonly repository: ReactNode;
}) {
  return (
    <>
      <span
        data-hero-greeting=""
        data-hero-piece="greeting"
        className="inline-block max-w-full @max-[60rem]:block"
      >
        What should we build in
      </span>{" "}
      {/* One unbreakable unit; its halves truncate before it outgrows the line. */}
      <span
        data-hero-breadcrumb=""
        className="inline-flex max-w-full items-baseline whitespace-nowrap align-baseline"
      >
        <span data-hero-piece="project" className="flex min-w-0 shrink items-baseline">
          {props.project}
        </span>
        <span
          aria-hidden
          data-hero-piece="slash"
          className="mx-[0.25em] shrink-0 text-muted-foreground/40"
        >
          /
        </span>
        <span data-hero-piece="repository" className="flex min-w-0 shrink items-baseline">
          {props.repository}
        </span>
        {/* Clear of the last glyph and the picker's underline. */}
        <span aria-hidden data-hero-piece="question" className="ms-[0.08em] shrink-0">
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
