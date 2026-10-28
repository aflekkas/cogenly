import type { EnvironmentConnectionPhase } from "@cogenly/client-runtime/connection";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Canonical connection-phase → dot color mapping shared by every status dot. */
export function connectionPhaseDotClassName(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Ping halo for transitional phases; null renders no ping. */
export function connectionPhasePingClassName(phase: EnvironmentConnectionPhase): string | null {
  return phase === "connecting" || phase === "reconnecting" ? "bg-warning/60" : null;
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  /**
   * Halo color for a state worth noticing, such as connecting. The dot pings
   * once when it enters that state, never on mount and never on a loop, so a
   * page left open does not keep repainting.
   */
  pingClassName?: string | null;
};

/**
 * The ping a dot should play: the halo it just changed to, until that one
 * ping ends. Derived during render so a dot that mounts mid-state stays still.
 */
function useArrivalPing(pingClassName: string | null) {
  const [seen, setSeen] = useState(pingClassName);
  const [arrival, setArrival] = useState<string | null>(null);
  if (pingClassName !== seen) {
    setSeen(pingClassName);
    setArrival(pingClassName);
  }
  return [arrival, () => setArrival(null)] as const;
}

export function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName = null,
}: ConnectionStatusDotProps) {
  const [arrivalPing, endPing] = useArrivalPing(pingClassName);
  const dotContent = (
    <>
      {arrivalPing ? (
        <span
          key={arrivalPing}
          aria-hidden
          className={cn(
            "absolute inline-flex h-full w-full animate-status-ping rounded-full motion-reduce:hidden",
            arrivalPing,
          )}
          onAnimationEnd={endPing}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="whitespace-pre-wrap">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
