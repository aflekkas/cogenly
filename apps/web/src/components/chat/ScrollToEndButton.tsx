import { ArrowDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { BadgeDot } from "../ui/badge-dot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Floating round button that returns the timeline to its live edge. It stays
 * mounted so it can scale and fade in and out, and so the composer layout can
 * measure it before it shows. A dot marks rows that arrived while away.
 */
export function ScrollToEndButton({
  visible,
  hasUnseen,
  onScrollToEnd,
}: {
  readonly visible: boolean;
  readonly hasUnseen: boolean;
  readonly onScrollToEnd: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Scroll to end"
            aria-hidden={visible ? undefined : true}
            tabIndex={visible ? undefined : -1}
            data-state={visible ? "visible" : "hidden"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onScrollToEnd}
            className={cn(
              "corner-glow relative inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-(--surface-edge,rgb(255_255_255/4%)) bg-message text-message-foreground shadow-(--surface-halo,none) [--corner-glow:6%]",
              "transition-[opacity,scale,background-color] duration-200 ease-out motion-reduce:transition-none",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              visible
                ? "pointer-events-auto scale-100 opacity-100"
                : "pointer-events-none scale-75 opacity-0",
            )}
          />
        }
      >
        <ArrowDownIcon aria-hidden className="size-4" />
        <BadgeDot
          tone={hasUnseen && "primary"}
          size="md"
          ring="background"
          className="absolute top-0.5 right-0.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">Scroll to end</TooltipPopup>
    </Tooltip>
  );
}
