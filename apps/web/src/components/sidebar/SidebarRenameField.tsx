import { RefreshCwIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The inline title editor on a sidebar row. When the thread's server can
 * name it, a trailing button hands the title back to the agent instead of
 * committing what was typed.
 */
export function SidebarRenameField(props: {
  value: string;
  ariaLabel: string;
  /** The input's own look; the field wraps it with the regenerate button. */
  inputClassName: string;
  /** Grow along the row, for rows that lay the title out horizontally. */
  fill?: boolean;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onRegenerate?: (() => void) | undefined;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", props.fill && "flex-1")}>
      <input
        autoFocus
        value={props.value}
        aria-label={props.ariaLabel}
        onChange={(event) => props.onChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={props.onKeyDown}
        onBlur={props.onBlur}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className={props.inputClassName}
      />
      {props.onRegenerate ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label="Regenerate title"
                // Keep focus in the input so pressing this does not commit the
                // typed title on blur first.
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRegenerate?.();
                }}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Regenerate title</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
