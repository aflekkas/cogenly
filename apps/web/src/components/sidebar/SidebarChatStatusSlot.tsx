import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";

const CHAT_STATUS_SPINNER_EXIT_MS = 220;
const chatStatusLayerClassName =
  "absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-(--motion-duration-base) ease-standard motion-reduce:transition-opacity";

/**
 * The fixed-size slot at the end of a Chats row. The spinner and the dot sit
 * in the same box and crossfade, so a turn starting or finishing never moves
 * the title. The spinner stays mounted just long enough to fade out.
 */
export function SidebarChatStatusSlot(props: {
  isRunning: boolean;
  dot: "info" | "warning" | null;
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
  return (
    <span aria-hidden className="relative size-3 shrink-0">
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
