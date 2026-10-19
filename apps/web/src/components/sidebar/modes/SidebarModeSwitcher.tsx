/**
 * Chats | Work | Agents as a segmented control: the mobile sheet's mode row;
 * wider windows switch modes from the navigation rail instead.
 * One pill slides between equal-width segments, so the control never reflows
 * when a badge appears. Arrow keys move between segments, as in any tablist.
 */
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { BotIcon, HammerIcon, type LucideIcon, MessageCircleIcon } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";

import { cn } from "~/lib/utils";
import { shortcutLabelForCommand } from "../../../keybindings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { decisionsWaitingLabel } from "../../../agents/agentWorkspace.logic";
import { SIDEBAR_MODE_LABELS, SIDEBAR_MODES, type SidebarMode } from "./sidebarModes.logic";

export const SIDEBAR_MODE_ICONS: Record<SidebarMode, LucideIcon> = {
  chats: MessageCircleIcon,
  tasks: HammerIcon,
  agents: BotIcon,
};

export function SidebarModeSwitcher(props: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  /** Agents waiting on the user; shows an amber count on the Agents segment. */
  decisionsWaiting: number;
  keybindings: ResolvedKeybindingsConfig;
  className?: string;
}) {
  const { mode, onModeChange, decisionsWaiting, keybindings } = props;
  const index = SIDEBAR_MODES.indexOf(mode);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "Home"
            ? -index
            : event.key === "End"
              ? SIDEBAR_MODES.length - 1 - index
              : 0;
    if (step === 0) return;
    event.preventDefault();
    const nextIndex = (index + step + SIDEBAR_MODES.length) % SIDEBAR_MODES.length;
    onModeChange(SIDEBAR_MODES[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Sidebar view"
      onKeyDown={handleKeyDown}
      className={cn(
        "@container/sidebar-modes relative grid h-8 grid-cols-3 rounded-lg bg-sidebar-foreground/[0.045] p-0.5",
        props.className,
      )}
    >
      <span
        aria-hidden
        data-testid="sidebar-mode-indicator"
        className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/3)] rounded-md state-selected [--state-selected-indicator:0] transition-transform duration-250 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {SIDEBAR_MODES.map((segment, segmentIndex) => {
        const selected = segment === mode;
        const label = SIDEBAR_MODE_LABELS[segment];
        const Icon = SIDEBAR_MODE_ICONS[segment];
        const shortcut = shortcutLabelForCommand(keybindings, `sidebar.mode.${segment}`);
        const badge = segment === "agents" && decisionsWaiting > 0 ? decisionsWaiting : null;
        return (
          <Tooltip key={segment}>
            <TooltipTrigger
              render={
                <button
                  ref={(node) => {
                    tabRefs.current[segmentIndex] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`sidebar-mode-tab-${segment}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  data-testid={`sidebar-mode-${segment}`}
                  onClick={() => onModeChange(segment)}
                  className={cn(
                    "relative z-10 flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected
                      ? "text-sidebar-foreground"
                      : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
                  )}
                />
              }
            >
              {/* Icons drop below the width where they would truncate the labels;
                  the badge needs more room, so its segment's icon drops sooner. */}
              <Icon
                aria-hidden
                className={cn(
                  "hidden size-3.5 shrink-0",
                  badge === null
                    ? "@[14.5rem]/sidebar-modes:block"
                    : "@[18.5rem]/sidebar-modes:block",
                )}
              />
              <span className="truncate">{label}</span>
              {badge !== null ? (
                <>
                  <span
                    aria-hidden
                    className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-3xs font-semibold leading-none text-background tabular-nums"
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                  <span className="sr-only">, {decisionsWaitingLabel(badge)}</span>
                </>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {shortcut ? `${label} (${shortcut})` : label}
              {badge !== null ? ` · ${decisionsWaitingLabel(badge)}` : null}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
