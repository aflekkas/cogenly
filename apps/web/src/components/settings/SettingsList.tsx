import { Children, useState, type ComponentProps, type ReactNode } from "react";

import { DisclosurePanel } from "../ui/disclosure";
import { SearchInput } from "../ui/search-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../../lib/utils";
import { SettingsDisclosureToggle, SettingsRowContent } from "./settingsLayout";
import { settingsSearchEscapeClears } from "./settingsList.logic";

export {
  SettingsEmpty as SettingsListEmpty,
  SettingsToolbar as SettingsListToolbar,
} from "./settingsLayout";

/**
 * Every settings search box. Escape clears the query and stays on the page;
 * on an empty box it reaches the page, which leaves Settings.
 */
export function SettingsListSearch({
  label,
  placeholder = label,
  width = "fill",
  value,
  onValueChange,
}: {
  label: string;
  /** Says what matches ("Search by package, version or license"); defaults to `label`. */
  placeholder?: string;
  /** `fill` takes the toolbar's free width; `field` is a `SettingsField` wide, beside a summary. */
  width?: "fill" | "field";
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <SearchInput
      size="sm"
      frameClassName={width === "fill" ? "min-w-40 flex-1" : "w-56 max-w-full"}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (!settingsSearchEscapeClears(event.nativeEvent, value)) return;
        event.preventDefault();
        event.stopPropagation();
        onValueChange("");
      }}
      clearLabel={`Clear ${label.toLowerCase()}`}
      onClear={() => onValueChange("")}
    />
  );
}

/**
 * A filter sized to its value and as tall as the search beside it; full width
 * once the toolbar wraps on a phone.
 */
export function SettingsListFilter({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onValueChange(next)}>
      <SelectTrigger size="toolbar" aria-label={label} className="w-full sm:w-auto">
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function SettingsList({ className, ...props }: ComponentProps<"ul">) {
  return <ul {...props} className={cn("divide-y divide-border/50", className)} />;
}

/**
 * A long list as a card's rows: the first `limit` entries, then the rest
 * folded behind a "N more" row with the settings disclosure toggle. Render it
 * directly in a `SettingsSection`, whose dividers then separate the parts.
 */
export function SettingsCappedList<T>({
  items,
  limit = 5,
  noun,
  renderItem,
}: {
  items: ReadonlyArray<T>;
  limit?: number;
  /** What the hidden entries are, plural: "failures" in "8 more failures". */
  noun: string;
  renderItem: (item: T) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // One hidden entry would take as much room as the row that folds it.
  const shown = items.length > limit + 1 ? items.slice(0, limit) : items;
  const rest = items.slice(shown.length);
  return (
    <>
      <SettingsList>{shown.map(renderItem)}</SettingsList>
      {rest.length > 0 ? (
        <>
          <DisclosurePanel open={open}>
            <SettingsList>{rest.map(renderItem)}</SettingsList>
          </DisclosurePanel>
          <div className="flex min-h-11 items-center justify-between gap-4 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
            <span>
              {rest.length} more {noun}
            </span>
            <SettingsDisclosureToggle
              open={open}
              onOpenChange={setOpen}
              label={`${rest.length} more ${noun}`}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

/** List entries use the same label, description and control layout as settings. */
export function SettingsListItem(props: ComponentProps<typeof SettingsRowContent>) {
  return (
    <li className="list-none">
      <SettingsRowContent {...props} />
    </li>
  );
}

/**
 * A list entry's facts as one muted line, "You · 2h ago · Private", for its
 * `status`. Each child is one fact; null children are skipped, so conditionals
 * go inline and the dots never double up.
 */
export function SettingsListMeta({ children }: { children: ReactNode }) {
  const shown = Children.toArray(children);
  if (shown.length === 0) return null;
  return (
    // Every fact carries its dot before it, in a gutter the line pulls into
    // the clipped space left of the list, so no line (first or wrapped)
    // starts with a dot or ends with one dangling.
    <span className="flex min-w-0 overflow-hidden">
      <span className="-ms-4 flex min-w-0 flex-wrap items-center gap-y-1">
        {shown.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- positions are the identity here
          <span key={index} className="flex min-w-0 items-center">
            <span aria-hidden className="w-4 shrink-0 text-center">
              ·
            </span>
            {item}
          </span>
        ))}
      </span>
    </span>
  );
}
