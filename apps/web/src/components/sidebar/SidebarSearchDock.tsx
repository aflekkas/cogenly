/**
 * The sidebar search dock: one boxed row pinned above every tab's list, or
 * below it in the bottom sidebar layout (Chats, Work, Agents, Projects,
 * Settings). Search owns the row's text and
 * spans it; the tab's own primary actions sit as icons at its end, after the
 * project filter on lists that have one: new chat, new task and add
 * repository, new agent, new project. Settings has none.
 */
import { FolderIcon, type LucideIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useMemo,
  useState,
} from "react";

import { type SidebarLayout, useSidebarLayout } from "~/appearancePreferences";
import { cn } from "~/lib/utils";
import { ProjectPickerRow } from "~/projectLabels/ProjectPickerRow";
import { ProjectTag } from "~/projectLabels/ProjectTag";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SearchInput } from "../ui/search-input";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type {
  SidebarProjectFilter,
  SidebarProjectFilterOption,
} from "./sidebarProjectFilter.logic";

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

/** A list's project filter, drawn as a folder button before the actions and a chip in the field. */
export interface SidebarDockProjectFilter {
  /** The filter as it applies now (`resolveSidebarProjectFilter`). */
  readonly value: SidebarProjectFilter;
  /** The list's projects with items, and No project (`sidebarProjectFilterOptions`). */
  readonly options: ReadonlyArray<SidebarProjectFilterOption>;
  /** The list's total, for the All row. */
  readonly total: number;
  readonly onChange: (next: SidebarProjectFilter) => void;
}

export interface SidebarSearchDockProps {
  /** Lists that file items in projects (Chats, Work, Agents) can be narrowed to one. */
  projectFilter?: SidebarDockProjectFilter | undefined;
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
  projectFilter,
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
  const chosenFilter =
    projectFilter && projectFilter.value !== null
      ? (projectFilter.options.find((option) => option.value === projectFilter.value) ?? null)
      : null;

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
      // The chosen project, removable, so a narrowed list always says why.
      leading={
        chosenFilter ? (
          <span key={chosenFilter.value} className="swap-motion flex min-w-0 max-w-[40%] shrink">
            <ProjectTag
              name={chosenFilter.project?.label.name ?? "No project"}
              color={chosenFilter.project?.label.color}
              dot
              removeLabel={`Show all, not only ${chosenFilter.project?.label.name ?? "No project"}`}
              onRemove={() => {
                projectFilter?.onChange(null);
                searchInputRef.current?.focus();
              }}
              className="max-w-full"
            />
          </span>
        ) : null
      }
      // Unfilled like the search field beside it: the buttons carry their own hover states, and
      // a background well reads far louder on themed palettes than on the base light and dark
      // ones.
      actions={
        projectFilter || actions.length > 0 ? (
          <>
            {projectFilter ? <SidebarProjectFilterPicker filter={projectFilter} /> : null}
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
  active = false,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  /** Draws the selected state, for a filter that is narrowing the list. */
  active?: boolean;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  const layout = useSidebarLayout();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            isActive={active}
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
      <TooltipPopup side={sidebarDockPopupSide(layout)}>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

type ProjectFilterChoice =
  | { readonly kind: "all"; readonly key: "all" }
  | ({ readonly kind: "option"; readonly key: string } & SidebarProjectFilterOption);

function projectFilterChoiceText(choice: ProjectFilterChoice): string {
  if (choice.kind === "all") return "All";
  return choice.project?.label.name ?? "No project";
}

/**
 * The dock's folder button: narrows the list to one project, or to items in
 * none. Lists the list's own projects with their counts, then No project, so
 * every choice holds something; All leads and clears it. Tinted while a
 * filter applies; the field's chip names it.
 */
function SidebarProjectFilterPicker({ filter }: { filter: SidebarDockProjectFilter }) {
  const layout = useSidebarLayout();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const choices = useMemo((): ProjectFilterChoice[] => {
    const needle = query.trim().toLowerCase();
    const options = filter.options
      .filter(
        (option) =>
          needle === "" ||
          (option.project?.label.name ?? "No project").toLowerCase().includes(needle),
      )
      .map((option) => ({ kind: "option" as const, key: option.value, ...option }));
    return needle === "" ? [{ kind: "all", key: "all" }, ...options] : options;
  }, [filter.options, query]);
  const chosen =
    filter.value === null
      ? null
      : (filter.options.find((option) => option.value === filter.value) ?? null);
  const label = chosen
    ? `Filtered to ${chosen.project?.label.name ?? "No project"}. Filter by project`
    : "Filter by project";
  return (
    <Combobox
      items={choices}
      filteredItems={choices}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={projectFilterChoiceText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(choice) => {
        if (!choice) return;
        filter.onChange(choice.kind === "all" ? null : choice.value);
        setOpen(false);
        setQuery("");
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton label={label} tooltip="Filter by project" active={!!chosen} />
        }
      >
        <FolderIcon />
      </ComboboxTrigger>
      <ComboboxPopup side={sidebarDockPopupSide(layout)} align="end" className="w-64">
        <ComboboxSearchInput
          aria-label="Find a project"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          {filter.options.length === 0 ? "Nothing here is in a project." : "No matching project."}
        </ComboboxEmpty>
        <ComboboxList>
          {(choice: ProjectFilterChoice) => (
            <ComboboxItem key={choice.key} value={choice} hideIndicator>
              {choice.kind === "all" ? (
                <ProjectPickerRow
                  icon={<FolderIcon />}
                  label="All"
                  chosen={filter.value === null}
                  meta={filter.total}
                />
              ) : (
                <ProjectPickerRow
                  project={choice.project}
                  label={choice.project?.label.name ?? "No project"}
                  chosen={choice.value === filter.value}
                  meta={choice.count}
                />
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** Popups from the dock and its count bar open toward the list, away from the column's edge. */
export function sidebarDockPopupSide(layout: SidebarLayout): "top" | "bottom" {
  return layout === "bottom" ? "top" : "bottom";
}
