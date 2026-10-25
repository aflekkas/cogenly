/**
 * The navigation rail: a narrow icon column at the window's left edge, beside
 * the thread list. Chats, Work and Agents switch the list from the top;
 * Search, Projects, Usage, Settings and Updates sit at the bottom. It stays put
 * while the list collapses, so modes, search and settings remain one click away.
 *
 * Mobile keeps the segmented control inside the sheet instead (see
 * SidebarModeSwitcher), so the rail renders only on wider windows.
 */
import { useAtomValue } from "@effect/atom-react";
import { PanelLeft, PanelLeftClose } from "lucide";
import { ChartNoAxesColumnIcon, SearchIcon, SettingsIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
} from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { useAgentsEmpty } from "../../agents/agentsClient";
import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import {
  preloadRailDestination,
  scheduleIdleRailPreload,
  type RailDestination,
} from "../../routeChunkPreload";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { MorphIcon } from "../MorphIcon";
import { NavRailUpdates } from "./NavRailUpdates";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { BadgeDot } from "../ui/badge-dot";
import { useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage } from "./mainAppLocation";
import { routeHidesListColumn, SIDEBAR_TOGGLE_DISABLED_LABEL } from "./listColumnRoutes";
import { SIDEBAR_MODE_ICONS } from "./modes/SidebarModeSwitcher";
import { modeNeedsYouLabel } from "./modes/modeAttention.logic";
import { SIDEBAR_MODE_LABELS, SIDEBAR_MODES, type SidebarMode } from "./modes/sidebarModes.logic";
import { crossfadeModeSwitch } from "./modes/modeSwitchMotion";
import { useModesNeedingAttention } from "./modes/useModesNeedingAttention";
import { useSelectSidebarMode } from "./modes/useSelectSidebarMode";
import { settingsReturnHref } from "./modes/spaceRouteMemory";
import { resolveVerticalTabIndex } from "./navRail.logic";
import { useNavRailBadgeStore } from "./navRailState";
import {
  MACHINE_NEEDS_ATTENTION_LABEL,
  useMachineHealthAttentionTone,
} from "../../machines/machineHealthAlertsStore";
import { decisionsWaitingLabel } from "../../agents/agentWorkspace.logic";
import {
  listColumnPeekToggleHandlers,
  toggleListColumn,
  useListColumnPeekStore,
} from "./ListColumnPeek";

const RAIL_BUTTON_CLASS =
  "relative flex size-[42px] shrink-0 cursor-pointer items-center justify-center rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-4.5 [&_svg]:shrink-0";

function railButtonTone(active: boolean) {
  // The selected button carries a quieter version of the selected card's
  // top-left light: in the reference its rim is a few levels and it has no
  // blue wash.
  return active
    ? "state-selected corner-glow [--corner-glow-border:0px] [--corner-glow:2%] [--corner-glow-top:1.5%] [--corner-wash:0%]"
    : "text-sidebar-muted-foreground state-hover";
}

function RailTooltip(props: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

// The sidebar toggle is chrome, not a tab: its state is aria-pressed and the
// icon, and hover only lifts the icon. A hover fill would match the selected
// tab's fill on the dark rail and read as a second selected tab.
const RAIL_TOGGLE_TONE =
  "text-sidebar-muted-foreground transition-colors duration-(--motion-duration-fast) ease-standard hover:text-sidebar-foreground motion-reduce:transition-none";

export function SidebarNavRail({
  showSidebarToggle = true,
}: {
  /** False where the toggle sits fixed after the macOS traffic lights instead. */
  showSidebarToggle?: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const mode = useUiStateStore((store) => store.sidebarMode);
  const selectSidebarMode = useSelectSidebarMode();
  const decisionsWaiting = useNavRailBadgeStore((store) => store.decisionsWaiting);
  const modesNeedingAttention = useModesNeedingAttention();
  // An open machine-health alert anywhere; the toast and Settings → Machines carry the details.
  const machineAttention = useMachineHealthAttentionTone();
  const { open, setOpen, toggleSidebar } = useSidebar();
  const sidebarVisible = useSidebarVisibility();
  const navigate = useNavigate();
  const router = useRouter();
  // The screens a rail button opens load their code while the app is idle,
  // and at once on hover or focus, so the first visit does not wait on it.
  useEffect(() => scheduleIdleRailPreload(router), [router]);
  const preloadOnIntent = (destination: RailDestination) => {
    const preload = () => preloadRailDestination(router, destination);
    return { onPointerEnter: preload, onFocus: preload };
  };
  const pathname = useLocation({ select: (location) => location.pathname });
  const onUtilityPage = isSidebarUtilityPage(pathname);
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const onUsage = pathname === "/usage";
  // Usage and an empty Agents list have no list column, so the
  // toggle stays in place but disabled there.
  const agentsEmpty = useAgentsEmpty();
  const listColumnHidden = routeHidesListColumn(pathname, {
    agentsEmpty: mode === "agents" && agentsEmpty,
  });
  const toggleShortcut = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen: onUsage },
  });
  const searchShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Hovering the toggle floats the collapsed list column out from under the
  // rail (ListColumnPeek); clicking it docks the column.
  const peekAvailable = useListColumnPeekStore((store) => store.available);

  const selectMode = (next: SidebarMode) => {
    // A utility page hands the column back to the thread list; another mode
    // returns to the page it last showed (spaceRouteMemory).
    selectSidebarMode(next, { leaveUtilityPage: true });
    // Another mode restores its own remembered list column (see
    // listColumnLayoutStore); picking the current mode again opens a collapsed one.
    if (next === mode && !open) setOpen(true);
  };

  const handleTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = SIDEBAR_MODES.indexOf(mode);
    const nextIndex = resolveVerticalTabIndex(event.key, index, SIDEBAR_MODES.length);
    if (nextIndex === null) return;
    event.preventDefault();
    selectSidebarMode(SIDEBAR_MODES[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  };

  // aria-disabled rather than disabled, so the tooltip still explains why.
  const sidebarToggle = (
    <RailTooltip
      label={
        listColumnHidden
          ? SIDEBAR_TOGGLE_DISABLED_LABEL
          : `Toggle main sidebar${toggleShortcut ? ` (${toggleShortcut})` : ""}`
      }
    >
      <button
        type="button"
        aria-label="Toggle main sidebar"
        aria-pressed={sidebarVisible && !listColumnHidden}
        aria-disabled={listColumnHidden || undefined}
        data-sidebar="trigger"
        onClick={listColumnHidden ? undefined : () => toggleListColumn(toggleSidebar)}
        // Chrome, like a native toolbar button: a click toggles the column
        // and leaves focus (and its ring) where it was, in the composer.
        onPointerDown={(event) => event.preventDefault()}
        {...listColumnPeekToggleHandlers}
        className={cn(
          RAIL_BUTTON_CLASS,
          RAIL_TOGGLE_TONE,
          "[-webkit-app-region:no-drag] aria-disabled:cursor-not-allowed aria-disabled:opacity-64 aria-disabled:hover:text-sidebar-muted-foreground",
        )}
      >
        <MorphIcon icon={sidebarVisible && !listColumnHidden ? PanelLeftClose : PanelLeft} />
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
        "relative z-20 hidden h-full w-(--nav-rail-width) shrink-0 flex-col items-center bg-nav-rail pb-2 text-sidebar-foreground desktop-layout:flex",
        // Above the floating list column, which slides out from under it.
        peekAvailable && "z-[46]",
      )}
    >
      {/* The titlebar row. It holds the sidebar toggle, sized and centred like
          the mode buttons. Where the macOS traffic lights own the row, it stays
          a drag strip under them and the toggle sits fixed just after them
          (AppSidebarLayout's SidebarControl). */}
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] w-full shrink-0 items-center justify-center",
          isElectron && "drag-region",
        )}
      >
        {showSidebarToggle ? sidebarToggle : null}
      </div>
      <div
        role="tablist"
        aria-label="Sidebar view"
        aria-orientation="vertical"
        onKeyDown={handleTabsKeyDown}
        // The toggle is chrome, not a mode: a wider gap sets it apart. The first
        // icon's centre lines up with the sidebar search dock beside it.
        className="mt-px flex flex-col items-center gap-1"
      >
        {SIDEBAR_MODES.map((segment, segmentIndex) => {
          // A utility page (Settings, Usage, Projects) owns the main area, so
          // no mode reads as current there.
          const selected = segment === mode && !onUtilityPage;
          const label = SIDEBAR_MODE_LABELS[segment];
          const Icon = SIDEBAR_MODE_ICONS[segment];
          const shortcut = shortcutLabelForCommand(keybindings, `sidebar.mode.${segment}`);
          const badge = segment === "agents" && decisionsWaiting > 0 ? decisionsWaiting : null;
          // Agents' amber count already says it, so the dot stands in only where
          // there is no count. It shows on the open mode too: opening a list
          // does not answer what is waiting in it.
          const needsYou = modesNeedingAttention.has(segment) && badge === null;
          return (
            <RailTooltip
              key={segment}
              label={[
                shortcut ? `${label} (${shortcut})` : label,
                badge !== null ? decisionsWaitingLabel(badge) : null,
                needsYou ? "Needs you" : null,
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
                aria-label={
                  badge !== null
                    ? `${label}, ${decisionsWaitingLabel(badge)}`
                    : needsYou
                      ? modeNeedsYouLabel(label)
                      : label
                }
                aria-selected={selected}
                tabIndex={segment === mode ? 0 : -1}
                data-testid={`sidebar-mode-${segment}`}
                // A click never parks focus on the tab, so no ring lingers after
                // it; the filled state alone says which mode is open. Keyboard
                // focus (arrows, Tab) still gets the ring.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMode(segment)}
                {...preloadOnIntent("threads")}
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
                <BadgeDot
                  tone={needsYou && "info"}
                  size="md"
                  ring="nav-rail"
                  className="absolute top-2 right-2"
                />
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
            {...preloadOnIntent("usage")}
            className={cn(RAIL_BUTTON_CLASS, railButtonTone(onUsage))}
          >
            <ChartNoAxesColumnIcon aria-hidden />
          </button>
        </RailTooltip>
        <RailTooltip
          label={
            machineAttention === null ? "Settings" : `Settings · ${MACHINE_NEEDS_ATTENTION_LABEL}`
          }
        >
          <button
            type="button"
            aria-label={
              machineAttention === null ? "Settings" : `Settings, ${MACHINE_NEEDS_ATTENTION_LABEL}`
            }
            aria-current={onSettings ? "page" : undefined}
            onClick={() => {
              // Settings again, with its column open, goes back to its first page.
              const href = onSettings
                ? open && pathname !== "/settings/general"
                  ? "/settings/general"
                  : null
                : settingsReturnHref();
              if (href === null) {
                if (!open) setOpen(true);
                return;
              }
              crossfadeModeSwitch(() => {
                if (!open) setOpen(true);
                void navigate({ href });
                return true;
              });
            }}
            {...preloadOnIntent("settings")}
            className={cn(RAIL_BUTTON_CLASS, railButtonTone(onSettings))}
          >
            <SettingsIcon aria-hidden />
            <BadgeDot
              tone={machineAttention}
              size="md"
              ring="nav-rail"
              className="absolute top-2 right-2"
            />
          </button>
        </RailTooltip>
        <NavRailUpdates
          buttonClassName={(active) => cn(RAIL_BUTTON_CLASS, railButtonTone(active))}
        />
      </div>
    </nav>
  );
}
