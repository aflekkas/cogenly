import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

const CHAT_STATUS_SPINNER_EXIT_MS = 220;
const chatStatusLayerClassName =
  "absolute inset-y-0 right-0 flex w-3 items-center justify-center transition-[opacity,scale] duration-(--motion-duration-base) ease-standard motion-reduce:transition-opacity";

/**
 * The slot at the end of a Chats row. The last-activity time ("20m"), the
 * spinner and the dot share it and crossfade: a live status replaces the time,
 * which stays in the layout (just transparent) so a turn starting or finishing
 * never moves the title. The spinner stays mounted just long enough to fade out.
 */
export function SidebarChatStatusSlot(props: {
  isRunning: boolean;
  dot: "info" | "warning" | null;
  /** Compact last-activity time; the parent refreshes it on its minute tick. */
  timeLabel?: string | undefined;
}) {
  const [spinnerLingers, setSpinnerLingers] = useState(props.isRunning);
  useEffect(() => {
    if (props.isRunning) {
      setSpinnerLingers(true);
      return;
    }
    const timer = setTimeout(() => setSpinnerLingers(false), CHAT_STATUS_SPINNER_EXIT_MS);
    return () => clearTimeout(timer);
  }, [props.isRunning]);
  const showDot = !props.isRunning && props.dot !== null;
  const showTime = !props.isRunning && !showDot;
  return (
    <span aria-hidden className="relative flex h-4 min-w-3 shrink-0 items-center justify-end">
      {props.timeLabel ? (
        <span
          className={cn(
            "text-xs whitespace-nowrap text-muted-foreground/70 tabular-nums transition-opacity duration-(--motion-duration-base) ease-standard motion-reduce:transition-none",
            showTime ? "opacity-100" : "opacity-0",
          )}
        >
          {props.timeLabel}
        </span>
      ) : null}
      {spinnerLingers || props.isRunning ? (
        <span
          className={cn(
            chatStatusLayerClassName,
            "swap-motion",
            props.isRunning ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        >
          <Spinner size="xs" tone="muted" />
        </span>
      ) : null}
      <span
        className={cn(
          chatStatusLayerClassName,
          showDot ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full transition-colors duration-(--motion-duration-base)",
            props.dot === "warning" ? "bg-warning" : "bg-info",
          )}
        />
      </span>
    </span>
  );
}
