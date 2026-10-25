import type { ComponentProps, ReactNode } from "react";

import { SearchInput } from "../ui/search-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../../lib/utils";
import { SettingsEmpty, SettingsRowContent } from "./settingsLayout";

export { SettingsToolbar as SettingsListToolbar } from "./settingsLayout";

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
      <SelectTrigger size="sm" aria-label={label}>
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

export function SettingsListEmpty({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return <SettingsEmpty icon={icon} title={title} description={description} action={children} />;
}
