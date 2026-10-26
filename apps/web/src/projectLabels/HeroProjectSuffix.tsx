import type { ReactNode } from "react";

import { HeroPhrase } from "../components/chat/HeroHeadline";

/**
 * The chat greeting's " · in <project>" tail, around the project's name. It
 * follows the greeting with a word space and wraps to the next line whole.
 */
export function HeroProjectSuffix(props: { readonly children: ReactNode }) {
  return (
    <>
      {" "}
      <HeroPhrase>
        {/* Spaces inside a flex line are dropped unless preserved. */}
        <span aria-hidden className="shrink-0 whitespace-pre text-muted-foreground/60">
          {"· "}
        </span>
        <span className="shrink-0 whitespace-pre">{"in "}</span>
        {props.children}
      </HeroPhrase>
    </>
  );
}
