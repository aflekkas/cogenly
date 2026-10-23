import type { MouseEventHandler } from "react";

import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  /** The panel edge the handle sits on: "left" for right-anchored panels, "right" for left-anchored ones. */
  edge: "left" | "right";
  handlers: ResizableWidthHandlers;
  /** Typically resets the panel to its default width. */
  onDoubleClick?: MouseEventHandler<HTMLDivElement> | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

/**
 * Hit target for resizing a side panel by dragging one of its edges. Place it
 * directly inside the panel's positioned box.
 *
 * - An 8px target centered on the edge (4px over each side), so the user can
 *   grab a few pixels off the edge without aiming.
 * - The indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor. It sits just outside the panel's edge: on desktop a
 *   browser page is a native view drawn over the panel, which would cover a
 *   line on the edge itself and leave only its ends showing.
 */
export function EdgeResizeHandle({
  edge,
  handlers,
  onDoubleClick,
  "aria-label": ariaLabel,
  className,
}: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      className={cn(
        // A named group: panels often sit inside a plain `group` ancestor.
        "group/edge-resize absolute inset-y-0 z-20 w-2 cursor-col-resize select-none",
        edge === "left" ? "-left-1" : "-right-1",
        className,
      )}
      onDoubleClick={onDoubleClick}
      {...handlers}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px bg-transparent transition-colors duration-150 group-hover/edge-resize:bg-border group-active/edge-resize:bg-primary/60",
          edge === "left" ? "left-[3px]" : "right-[3px]",
        )}
      />
    </div>
  );
}
