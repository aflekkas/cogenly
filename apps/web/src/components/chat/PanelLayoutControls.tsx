import { PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo } from "react";

import { BadgeDot } from "../ui/badge-dot";
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
    /** An agent command is running: the panel never opens for it, so the toggle shows a dot. */
    activity: boolean;
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
  const bottomPanelLabel =
    bottomPanel?.activity === true
      ? "Toggle terminal panel, agent command running"
      : "Toggle terminal panel";
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {bottomPanel ? (
        <Tooltip>
          <TooltipTrigger render={<span className="relative flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={bottomPanel.open}
              onPressedChange={bottomPanel.onToggle}
              aria-label={bottomPanelLabel}
              data-bottom-panel-toggle
              variant="ghost-muted"
              size="sm"
            >
              <PanelBottomIcon className="size-4.5" />
            </Toggle>
            <BadgeDot tone={bottomPanel.activity && "success"} className="absolute top-1 right-1" />
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
