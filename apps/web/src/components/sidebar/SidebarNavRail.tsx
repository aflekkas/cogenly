/**
 * The navigation rail: a narrow icon column at the window's left edge, beside
 * the thread list. Chats, Work, Agents and Projects switch the list from the top;
 * Search, Usage and Settings sit at the bottom. It stays put while the list
 * collapses, so modes, search and settings remain one click away.
 *
 * Mobile keeps the segmented control inside the sheet instead (see
 * SidebarModeSwitcher), so the rail renders only on wider windows.
 */
import { useAtomValue } from "@effect/atom-react";
import { PanelLeft, PanelLeftClose } from "lucide";
import { ChartNoAxesColumnIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactElement, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { MorphIcon } from "../MorphIcon";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage } from "./mainAppLocation";
import { SIDEBAR_MODE_ICONS } from "./modes/SidebarModeSwitcher";
import { SIDEBAR_MODE_LABELS, SIDEBAR_MODES, type SidebarMode } from "./modes/sidebarModes.logic";
import { useSelectSidebarMode } from "./modes/useSelectSidebarMode";
import { resolveVerticalTabIndex } from "./navRail.logic";
import { useNavRailBadgeStore } from "./navRailState";
import { decisionsWaitingLabel } from "../../agents/agentWorkspace.logic";

const RAIL_BUTTON_CLASS =
  "relative flex size-[42px] shrink-0 cursor-pointer items-center justify-center rounded-rail outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-4.5 [&_svg]:shrink-0";

function railButtonTone(active: boolean) {
  return active ? "state-selected" : "text-sidebar-muted-foreground state-hover";
}

function RailTooltip(props: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarNavRail({
  sidebarToggleBelowTitlebar,
}: {
  sidebarToggleBelowTitlebar: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const mode = useUiStateStore((store) => store.sidebarMode);
  const selectSidebarMode = useSelectSidebarMode();
  const decisionsWaiting = useNavRailBadgeStore((store) => store.decisionsWaiting);
  const { open, setOpen, toggleSidebar } = useSidebar();
  const sidebarVisible = useSidebarVisibility();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const onUtilityPage = isSidebarUtilityPage(pathname);
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const onUsage = pathname === "/usage";
  const toggleShortcut = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen: onUsage },
  });
  const searchShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectMode = (next: SidebarMode) => {
    // A utility page hands the column back to the thread list.
    selectSidebarMode(next, { leaveUtilityPage: true });
    // A collapsed list opens on the mode picked.
    if (!open) setOpen(true);
  };

  const handleTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = SIDEBAR_MODES.indexOf(mode);
    const nextIndex = resolveVerticalTabIndex(event.key, index, SIDEBAR_MODES.length);
    if (nextIndex === null) return;
    event.preventDefault();
    selectSidebarMode(SIDEBAR_MODES[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  };

  const sidebarToggle = (
    <RailTooltip label={`Toggle main sidebar${toggleShortcut ? ` (${toggleShortcut})` : ""}`}>
      <button
        type="button"
        aria-label="Toggle main sidebar"
        aria-pressed={sidebarVisible}
        data-sidebar="trigger"
        onClick={toggleSidebar}
        className={cn(RAIL_BUTTON_CLASS, railButtonTone(false), "[-webkit-app-region:no-drag]")}
      >
        <MorphIcon icon={sidebarVisible ? PanelLeftClose : PanelLeft} />
      </button>
    </RailTooltip>
  );

  return (
    <nav
      aria-label="Workspace"
      // Shares the sidebar's palette scope, with its own muted and selected tones.
      data-app-sidebar=""
      data-nav-rail=""
      className={cn(
        "relative z-20 hidden h-full w-(--nav-rail-width) shrink-0 flex-col items-center bg-nav-rail surface-grain pb-2 text-sidebar-foreground md:flex",
      )}
    >
      {/* The titlebar row. It holds the sidebar toggle, sized and centred like
          the mode buttons. Where the macOS traffic lights own the row, it stays
          an empty drag strip and the toggle leads the buttons below it. */}
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] w-full shrink-0 items-center justify-center",
          isElectron && "drag-region",
        )}
      >
        {sidebarToggleBelowTitlebar || onUsage ? null : sidebarToggle}
      </div>
      {/* Usage has no list column, so nothing to toggle there. */}
      {sidebarToggleBelowTitlebar && !onUsage ? sidebarToggle : null}
      <div
        role="tablist"
        aria-label="Sidebar view"
        aria-orientation="vertical"
        onKeyDown={handleTabsKeyDown}
        // The toggle is chrome, not a mode: a wider gap sets it apart.
        className="mt-1.5 flex flex-col items-center gap-1"
      >
        {SIDEBAR_MODES.map((segment, segmentIndex) => {
          // A utility page owns the column, so no mode reads as current there.
          const selected = segment === mode && !onUtilityPage;
          const label = SIDEBAR_MODE_LABELS[segment];
          const Icon = SIDEBAR_MODE_ICONS[segment];
          const shortcut = shortcutLabelForCommand(keybindings, `sidebar.mode.${segment}`);
          const badge = segment === "agents" && decisionsWaiting > 0 ? decisionsWaiting : null;
          return (
            <RailTooltip
              key={segment}
              label={[
                shortcut ? `${label} (${shortcut})` : label,
                badge !== null ? decisionsWaitingLabel(badge) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <button
                ref={(node) => {
                  tabRefs.current[segmentIndex] = node;
                }}
                type="button"
                role="tab"
                id={`sidebar-mode-tab-${segment}`}
                aria-label={badge !== null ? `${label}, ${decisionsWaitingLabel(badge)}` : label}
                aria-selected={selected}
                tabIndex={segment === mode ? 0 : -1}
                data-testid={`sidebar-mode-${segment}`}
                onClick={() => selectMode(segment)}
                className={cn(RAIL_BUTTON_CLASS, railButtonTone(selected))}
              >
                <Icon aria-hidden />
                {badge !== null ? (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-3xs font-semibold leading-none text-background tabular-nums ring-2 ring-sidebar"
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                ) : null}
              </button>
            </RailTooltip>
          );
        })}
      </div>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1">
        {/* Search is the command palette: it finds threads in every mode,
            agents, projects and settings, so it lives outside the modes. */}
        <RailTooltip label={searchShortcut ? `Search (${searchShortcut})` : "Search"}>
          <button
            type="button"
            aria-label="Search"
            aria-haspopup="dialog"
            onClick={() => openCommandPalette()}
            className={cn(RAIL_BUTTON_CLASS, railButtonTone(false))}
          >
            <SearchIcon aria-hidden />
          </button>
        </RailTooltip>
        <RailTooltip label="Usage">
          <button
            type="button"
            aria-label="Usage"
            aria-current={onUsage ? "page" : undefined}
            onClick={() => void navigate({ to: "/usage" })}
            className={cn(RAIL_BUTTON_CLASS, railButtonTone(onUsage))}
          >
            <ChartNoAxesColumnIcon aria-hidden />
          </button>
        </RailTooltip>
        <RailTooltip label="Settings">
          <button
            type="button"
            aria-label="Settings"
            aria-current={onSettings ? "page" : undefined}
            onClick={() => {
              if (!open) setOpen(true);
              if (!onSettings) void navigate({ to: "/settings" });
            }}
            className={cn(RAIL_BUTTON_CLASS, railButtonTone(onSettings))}
          >
            <SettingsIcon aria-hidden />
          </button>
        </RailTooltip>
      </div>
    </nav>
  );
}
