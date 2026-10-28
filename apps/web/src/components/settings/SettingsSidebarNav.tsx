import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  BrainIcon,
  DatabaseIcon,
  CalendarClockIcon,
  FolderIcon,
  GitBranchIcon,
  HardDriveIcon,
  ImportIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  KeyRoundIcon,
  Link2Icon,
  MessageSquarePlusIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { useLegacySidebarEnabled } from "../../hooks/useSettings";
import { SidebarContent, SidebarFooter, SidebarGroup, useSidebar } from "../ui/sidebar";
import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";
import { useSidebarLayout } from "../../appearancePreferences";
import {
  SidebarGroupHeader,
  SidebarList,
  SidebarRowSubtitle,
  sidebarRowClassName,
} from "../sidebar/SidebarList";
import { SidebarListColumn } from "../sidebar/SidebarListColumn";
import { SidebarSearchDock, type SidebarDockAction } from "../sidebar/SidebarSearchDock";
import { sidebarListEdge, stepSearchResultIndex } from "../sidebar/sidebarListAnchor.logic";
import { BadgeDot } from "../ui/badge-dot";
import { useSettingsAttentionByPage } from "../../machines/machineHealthAlertsStore";
import { SETTINGS_PAGE_NEEDS_ATTENTION_LABEL } from "./settingsAttention.logic";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  settingsNavPathFor,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": ActivityIcon,
  "/settings/models": SparklesIcon,
  "/settings/new-threads": MessageSquarePlusIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/project-tags": FolderIcon,
  "/settings/memory": BrainIcon,
  "/settings/vault": KeyRoundIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/data": DatabaseIcon,
  "/settings/import": ImportIcon,
  "/settings/connections": Link2Icon,
  "/settings/machines": MonitorSmartphoneIcon,
  "/settings/archived": ArchiveIcon,
};

const SETTINGS_ICON_CLASS_NAME = "size-4 shrink-0 text-sidebar-muted-foreground";
const NO_DOCK_ACTIONS: ReadonlyArray<SidebarDockAction> = [];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = useMemo(() => validateSettingsScopeSearch(currentSearch), [currentSearch]);
  // Detail pages (Repository, Open-source licenses) highlight their parent.
  const activeNavPath = settingsNavPathFor(pathname);
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const navRailVisible = !isMobile && !legacySidebarEnabled;
  const sidebarLayout = useSidebarLayout();
  const searchEdge = sidebarListEdge({
    layout: sidebarLayout,
    searching: true,
    mode: "settings",
    shelf: null,
  });
  const sectionsEdge = sidebarListEdge({
    layout: sidebarLayout,
    searching: false,
    mode: "settings",
    shelf: null,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [storedResultIndex, setActiveResultIndex] = useState(0);
  const attentionByPage = useSettingsAttentionByPage();
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  const results = useMemo(() => searchSettings(query, searchableItems), [query, searchableItems]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  // A narrowed query keeps the highlight on the last result rather than past it.
  const activeResultIndex = Math.min(storedResultIndex, Math.max(results.length - 1, 0));

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          // Preserve dialog and popup focus traps, and let shortcut recorders
          // capture the keypress without moving focus into the sidebar search.
          target.closest(
            '[role="dialog"], [aria-modal="true"], [data-slot$="popup"], [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  // Picking a section selects its row the way picking a thread does: the row
  // takes the selected fill at once and the page swaps, with no crossfade.
  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to,
        hash: "",
        replace: true,
        hashScrollIntoView: false,
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({
        to: item.to,
        hash: targetId,
        replace: true,
        hashScrollIntoView: false,
        state: { settingsTargetHighlight: true },
      });
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const key = event.key;
        setActiveResultIndex(
          stepSearchResultIndex(key, activeResultIndex, results.length, searchEdge),
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results, searchEdge],
  );
  // The same search dock, in the same place, as every other tab (above the
  // list, or below it in the bottom layout); Settings has no create action.
  const searchDock = (
    <SidebarGroup className="z-[1]">
      <SidebarSearchDock
        actions={NO_DOCK_ACTIONS}
        searchInputRef={searchInputRef}
        searchQuery={query}
        onSearchQueryChange={(value) => {
          setQuery(value);
          setActiveResultIndex(0);
        }}
        onSearchKeyDown={handleSearchKeyDown}
        searchLabel="Search settings"
        clearLabel="Clear settings search"
        shortcut="/"
        results={{
          listId: "settings-search-results",
          optionId: (index) => `settings-search-result-${results[index]?.id ?? ""}`,
          visible: isSearching,
          count: results.length,
          activeIndex: activeResultIndex,
        }}
        onClearSearch={clearSearch}
      />
    </SidebarGroup>
  );
  return (
    <>
      <SidebarContent
        className="min-h-full"
        fixedHeader={sidebarLayout === "top" ? searchDock : null}
        fixedFooter={sidebarLayout === "bottom" ? searchDock : null}
      >
        {isSearching ? (
          // Results sit by the dock with the best match nearest the input:
          // reading down from it, or in the bottom layout stacked up against
          // it like a command palette, so the rows render in reverse rank.
          <SidebarListColumn listKey="settings:search" edge={searchEdge}>
            {hasResults ? (
              <SidebarList
                id="settings-search-results"
                role="listbox"
                aria-label="Settings search results"
              >
                {(searchEdge === "bottom" ? results.toReversed() : results).map((item, row) => {
                  const index = searchEdge === "bottom" ? results.length - 1 - row : row;
                  const Icon = SETTINGS_SECTION_ICONS[item.to];
                  return (
                    // A row a new query brings in fades in; one that stays put doesn't.
                    <li
                      key={item.id}
                      role="presentation"
                      className="list-none transition-opacity duration-(--motion-duration-fast) ease-out starting:opacity-0"
                    >
                      <button
                        type="button"
                        id={`settings-search-result-${item.id}`}
                        role="option"
                        aria-selected={index === activeResultIndex}
                        tabIndex={-1}
                        className={sidebarRowClassName({
                          selected: index === activeResultIndex,
                          lines: 2,
                        })}
                        onMouseMove={() => setActiveResultIndex(index)}
                        onClick={() => handleSearchResultClick(item)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col justify-center">
                          <span className="flex min-w-0 items-center gap-2 text-sm">
                            <Icon className={SETTINGS_ICON_CLASS_NAME} />
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {item.title}
                            </span>
                          </span>
                          <SidebarRowSubtitle>
                            <span className="min-w-0 flex-1 truncate">
                              {SETTINGS_SECTION_LABELS[item.to]}
                            </span>
                          </SidebarRowSubtitle>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </SidebarList>
            ) : (
              <p
                role="status"
                className="flex flex-1 items-center justify-center px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                No settings found
              </p>
            )}
          </SidebarListColumn>
        ) : (
          // The sections read down from the dock, grouped under static
          // headings, or in the bottom layout stack up against it in the same
          // reading order. Each is a plain sidebar row that carries its own
          // selected fill, as a chat row does.
          <SidebarListColumn listKey="settings:sections" edge={sectionsEdge}>
            <SidebarList aria-label="Settings sections">
              {SETTINGS_NAV_GROUPS.flatMap((group) => [
                ...(group.label === null
                  ? []
                  : [<SidebarGroupHeader key={`group:${group.label}`} label={group.label} />]),
                ...group.paths.map((to) => {
                  const Icon = SETTINGS_SECTION_ICONS[to];
                  const isActive = to === activeNavPath;
                  const attention = attentionByPage.get(to) ?? null;
                  return (
                    <li key={to} className="list-none">
                      <button
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        aria-label={
                          attention === null
                            ? undefined
                            : `${SETTINGS_SECTION_LABELS[to]}, ${SETTINGS_PAGE_NEEDS_ATTENTION_LABEL}`
                        }
                        className={sidebarRowClassName({ selected: isActive })}
                        onClick={() => handleSectionClick(to)}
                      >
                        <Icon className={SETTINGS_ICON_CLASS_NAME} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-sm",
                            isActive ? "text-foreground" : "text-foreground/80",
                          )}
                        >
                          {SETTINGS_SECTION_LABELS[to]}
                        </span>
                        {/* The page behind the rail's Settings dot (settingsAttention.logic). */}
                        <BadgeDot tone={attention} size="md" className="shrink-0" />
                      </button>
                    </li>
                  );
                }),
              ])}
            </SidebarList>
          </SidebarListColumn>
        )}
      </SidebarContent>
      {/* Beside the navigation rail (which carries Settings, Usage and Updates)
          the footer holds only what renders. */}
      <SidebarFooter className="empty:hidden">
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        {navRailVisible ? (
          <Suspense fallback={null}>
            <T3ConnectSidebarAvatar />
          </Suspense>
        ) : (
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <SidebarUtilityMenu />
            </div>
            <Suspense fallback={null}>
              <T3ConnectSidebarAvatar />
            </Suspense>
          </div>
        )}
      </SidebarFooter>
    </>
  );
}
