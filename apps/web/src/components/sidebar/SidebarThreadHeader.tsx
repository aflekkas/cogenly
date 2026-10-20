/**
 * The sidebar search dock: one boxed row holding search, add repository and
 * new thread, pinned under the list.
 *
 * Search owns the row's text and spans it; add-repository and new-thread sit
 * as a pair of icons at the end, after any mode-specific filter. Chats has no
 * add-repository: repositories belong to Work.
 */
import { FolderPlusIcon, SquarePenIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { SearchInput } from "../ui/search-input";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Add repository only shows once one exists; the empty state offers it otherwise. */
  hasProjects: boolean;
  /** Optional mode-specific control before the add/new pair, such as the Chats project filter. */
  filterControl?: ReactNode;
  /** Null hides add repository (Chats); the command palette still offers it. */
  onNewProject: (() => void) | null;
  /** Receives the click so Shift+click can skip the project picker. */
  onNewThread: (event: ReactMouseEvent) => void;
  /** What the new button makes in the current sidebar mode; defaults to "New thread". */
  newThreadLabel?: string;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  /** Shift+click only matters once there is more than one project to pick. */
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  filterControl,
  onNewProject,
  onNewThread,
  newThreadLabel: newItemLabel = "New thread",
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `${newItemLabel} (${newThreadShortcutLabel})`
    : newItemLabel;

  return (
    <SearchInput
      ref={searchInputRef}
      size="md"
      value={searchQuery}
      onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
      onKeyDown={onSearchKeyDown}
      placeholder="Search"
      aria-label="Search threads"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={resultsVisible}
      aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
      aria-activedescendant={
        activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
      }
      clearLabel="Clear thread search"
      onClear={() => {
        onClearSearch();
        searchInputRef.current?.focus();
      }}
      // Unfilled like the search field beside it: the buttons carry their own hover states, and
      // a background well reads far louder on themed palettes than on the base light and dark
      // ones.
      actions={
        <>
          {filterControl}
          {hasProjects && onNewProject ? (
            <SidebarHeaderIconButton label="Add repository" onClick={onNewProject}>
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
          ) : null}
          <SidebarHeaderIconButton
            label={newItemLabel}
            tooltip={
              showNewThreadInProjectHint ? (
                <span className="flex flex-col gap-0.5">
                  <span>{newThreadLabel}</span>
                  <span className="text-muted-foreground">
                    New thread in current repository: Shift+click
                    {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                  </span>
                </span>
              ) : (
                newThreadLabel
              )
            }
            disabled={newThreadDisabled}
            onClick={onNewThread}
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
        </>
      }
    />
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
