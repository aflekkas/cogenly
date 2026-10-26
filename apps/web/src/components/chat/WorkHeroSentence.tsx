import type { ReactNode } from "react";

import type { WorkHeroCrumb } from "~/projectLabels/projectMeta.logic";
import { HeroName, HeroPhrase } from "./HeroHeadline";

/**
 * Work's "What should we build in <project> / <repository>?". The names follow
 * "in" with a word space; "<project> / <repository>?" wraps to the next line
 * whole when it does not fit.
 */
export function WorkHeroSentence(props: {
  readonly project: ReactNode;
  readonly repository: ReactNode;
}) {
  return (
    <>
      What should we build in{" "}
      <HeroPhrase>
        <span className="flex min-w-0 shrink items-baseline">{props.project}</span>
        <span aria-hidden className="mx-[0.25em] shrink-0 text-muted-foreground/40">
          /
        </span>
        <span className="flex min-w-0 shrink items-baseline">{props.repository}</span>
        <span aria-hidden className="shrink-0">
          ?
        </span>
      </HeroPhrase>
    </>
  );
}

/** A read-only half of the sentence; a placeholder ("No project") reads muted. */
export function WorkHeroCrumbText(props: {
  readonly crumb: WorkHeroCrumb;
  readonly icon?: ReactNode;
}) {
  return (
    <HeroName text={props.crumb.text} placeholder={props.crumb.placeholder} icon={props.icon} />
  );
}
