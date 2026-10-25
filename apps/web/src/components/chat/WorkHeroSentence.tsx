import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { WorkHeroCrumb } from "~/projectLabels/projectMeta.logic";

/** A single sentence with reserved name widths, so project picks never rewrap it. */
export function WorkHeroSentence(props: {
  readonly project: ReactNode;
  readonly repository: ReactNode;
}) {
  return (
    <>
      <span data-hero-greeting="" data-hero-piece="greeting" className="inline">
        What should we build in
      </span>{" "}
      {/* One unbreakable unit; its halves truncate before it outgrows the line. */}
      <span
        data-hero-breadcrumb=""
        className="inline-flex w-[calc(28rem+2em)] max-w-full items-baseline justify-center whitespace-nowrap align-baseline"
      >
        <span data-hero-piece="project" className="flex max-w-64 min-w-0 shrink items-baseline">
          {props.project}
        </span>
        <span
          aria-hidden
          data-hero-piece="slash"
          className="mx-[0.25em] shrink-0 text-muted-foreground/40"
        >
          /
        </span>
        <span data-hero-piece="repository" className="flex max-w-64 min-w-0 shrink items-baseline">
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
