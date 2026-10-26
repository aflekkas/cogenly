import { Children, Fragment, type ComponentProps, type ReactNode } from "react";

import { SearchInput } from "../ui/search-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../../lib/utils";
import { SettingsRowContent } from "./settingsLayout";

export {
  SettingsEmpty as SettingsListEmpty,
  SettingsToolbar as SettingsListToolbar,
} from "./settingsLayout";

export function SettingsListSearch({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <SearchInput
      size="sm"
      frameClassName="min-w-40 flex-1"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
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
      <SelectTrigger aria-label={label} className="w-full sm:w-auto">
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
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {shown.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- positions are the identity here
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden>·</span> : null}
          {item}
        </Fragment>
      ))}
    </span>
  );
}
