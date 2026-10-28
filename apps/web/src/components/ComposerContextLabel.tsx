import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";

/** Keeps text measurable while the composer's outer label box collapses. */
export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
}) {
  return (
    <span
      data-composer-label
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 overflow-x-clip overflow-y-visible text-left"
          : "max-w-[240px] group-data-[compact]/composer-context:max-w-0",
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LABEL_CLASS,
          displayMode === "toolbar" &&
            "max-w-[240px] transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none",
        )}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * A context strip choice that can no longer change (the machine or project
 * once a chat has started): the `xs` composer control's box and text, without
 * the button. It carries the control's height (h-7 sm:h-6) as well as its
 * padding: the strip has no min-height of its own, and the glass seam joining
 * it to the composer assumes a fixed strip height, so a shorter row would drag
 * the seam out of line whenever it is the only thing in the strip.
 */
export function ComposerContextStatic({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-composer-context-control
      className={cn(
        "inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground text-xs sm:h-6",
        className,
      )}
      {...props}
    />
  );
}

// Tooltips on the composer's context strip open below, away from the composer
// card above them, and flip against the viewport alone: the strip clips
// horizontal overflow, which would otherwise count as the tooltip's room and
// bounce it back over the card.
export const COMPOSER_CONTEXT_TOOLTIP = {
  side: "bottom",
  collisionBoundary: [] as Element[],
} as const;
