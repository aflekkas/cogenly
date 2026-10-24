/**
 * The sidebar search dock: one boxed row pinned above every tab's list
 * (Chats, Work, Agents, Projects, Settings). Search owns the row's text and
 * spans it; the tab's own primary actions sit as icons at its end, after any
 * mode-specific filter: new chat, new task and add repository, new agent, new
 * project. Settings has none.
 */
import type { LucideIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { SearchInput } from "../ui/search-input";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One of a tab's primary actions at the end of the search dock. */
export interface SidebarDockAction {
  readonly id: string;
  /** Accessible name and tooltip ("New project"). */
  readonly label: string;
  /** The keyboard shortcut, shown in the tooltip. */
  readonly shortcutLabel?: string | null | undefined;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly disabled?: boolean | undefined;
}

export interface SidebarSearchDockProps {
  /** Optional mode-specific control before the actions, such as the Chats project filter. */
  filterControl?: ReactNode;
  actions: ReadonlyArray<SidebarDockAction>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** What the field searches, for its accessible name ("Search threads"). */
  searchLabel: string;
  clearLabel: string;
  /** A shortcut hint shown while the field is empty, such as `/`. */
  shortcut?: string | undefined;
  /** The results list the field drives as a combobox, while it shows. */
  results: {
    readonly listId: string;
    readonly optionId: (index: number) => string;
    readonly visible: boolean;
    readonly count: number;
    readonly activeIndex: number;
  };
  onClearSearch: () => void;
}

export function SidebarSearchDock({
  filterControl,
  actions,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  searchLabel,
  clearLabel,
  shortcut,
  results,
  onClearSearch,
}: SidebarSearchDockProps) {
  const resultsVisible = results.visible && results.count > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && results.activeIndex < results.count;

  return (
    <SearchInput
      ref={searchInputRef}
      size="md"
      value={searchQuery}
      onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
      onKeyDown={onSearchKeyDown}
      placeholder="Search"
      aria-label={searchLabel}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={resultsVisible}
      aria-controls={resultsVisible ? results.listId : undefined}
      aria-activedescendant={activeResultExists ? results.optionId(results.activeIndex) : undefined}
      clearLabel={clearLabel}
      shortcut={shortcut}
      onClear={() => {
        onClearSearch();
        searchInputRef.current?.focus();
      }}
      // Unfilled like the search field beside it: the buttons carry their own hover states, and
      // a background well reads far louder on themed palettes than on the base light and dark
      // ones.
      actions={
        filterControl || actions.length > 0 ? (
          <>
            {filterControl}
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <SidebarHeaderIconButton
                  key={action.id}
                  label={action.label}
                  tooltip={
                    action.shortcutLabel
                      ? `${action.label} (${action.shortcutLabel})`
                      : action.label
                  }
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  <Icon />
                </SidebarHeaderIconButton>
              );
            })}
          </>
        ) : undefined
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
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
