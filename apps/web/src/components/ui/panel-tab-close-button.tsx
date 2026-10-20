import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface PanelTabCloseButtonProps {
  children: ReactNode;
  label: string;
  onClick: () => void;
  tooltip?: string;
  /**
   * False inside a keyboard-navigable tab whose own key handling closes it
   * (Delete), so the tab strip stays a single tab stop.
   */
  focusable?: boolean;
}

/**
 * Inside a `group/tab` row, swaps the tab identity for its close action on
 * hover, while the tab has keyboard focus, or while the button itself does.
 */
export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
  focusable = true,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
      aria-label={label}
      tabIndex={focusable ? undefined : -1}
      onClick={onClick}
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/tab:hidden group-focus-visible/close:hidden">
        {children}
      </span>
      <X className="hidden size-3 group-hover/tab:block group-focus-visible/tab:block group-focus-visible/close:block" />
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
