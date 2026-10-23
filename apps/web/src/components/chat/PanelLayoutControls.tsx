import { PanelRightIcon, SquareTerminalIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  onToggleRightPanel: () => void;
  /** The bottom panel of agent terminals; left out where the thread has none. */
  bottomPanel?: {
    open: boolean;
    shortcutLabel: string | null;
    onToggle: () => void;
  };
}

/**
 * The bottom and right panels' toggles. What the right panel holds is chosen
 * from its own tab strip; the bottom panel shows the agents' commands.
 */
export const PanelLayoutControls = memo(function PanelLayoutControls({
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  onToggleRightPanel,
  bottomPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {bottomPanel ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={bottomPanel.open}
              onPressedChange={bottomPanel.onToggle}
              aria-label="Toggle terminal panel"
              data-bottom-panel-toggle
              variant="ghost-muted"
              size="sm"
            >
              <SquareTerminalIcon className="size-4.5" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {`Toggle terminal panel${bottomPanel.shortcutLabel ? ` (${bottomPanel.shortcutLabel})` : ""}`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label="Toggle right panel"
            variant="ghost-muted"
            size="sm"
            disabled={!rightPanelAvailable}
          >
            <PanelRightIcon className="size-4.5" />
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
            : rightPanelUnavailableLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost-muted"
            size="sm"
          >
            <MorphIcon className="size-4.5" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
