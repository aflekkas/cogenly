import { resolveEnvironmentMachineKind } from "@cogenly/contracts";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { InlineButton } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  selectMachineScope,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

/** Pages with their own targeting, rather than a machine scope. */
export const SETTINGS_SCOPELESS_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/keybindings",
  "/settings/connections",
  // Projects span every connected machine; the page names each project's own.
  "/settings/project-tags",
]);

/**
 * "Settings for <MacBook>" at the top of a page about one machine's own
 * state. Every other page's settings are global: universal settings are
 * written to every machine, and a machine-local row names its machine.
 */
export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  if (pathname === "/settings/appearance" || pathname === "/settings/keybindings")
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {/* Sidebar layout stays on the device that set it (appearancePreferences.ts). */}
        {pathname === "/settings/appearance"
          ? "Shared across your machines, except Sidebar layout"
          : "Shared across your machines"}
      </p>
    );
  if (scope === null || !scope.machinePage || SETTINGS_SCOPELESS_PATHS.has(pathname)) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      <span className="shrink-0">Settings for</span>
      <MachineScopeMenu />
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
        ) : null}
      </span>
      {option.offline ? (
        <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
      ) : null}
    </>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  searchLabel,
  quiet,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  searchLabel: string;
  quiet: boolean;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Nothing to switch to: name the machine without offering a menu.
  if (options.length <= 1 && options.every((option) => option.value === value)) {
    return (
      <span className="inline-flex min-w-0 max-w-72 items-center gap-1.5">
        {quiet ? null : icon}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    );
  }
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={
        <InlineButton tone={quiet ? "muted" : "picker"} weight={quiet ? "normal" : undefined} />
      }
      className="min-w-0 max-w-72"
    >
      {quiet ? null : icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        className={quiet ? "size-3 shrink-0" : "size-3.5 shrink-0 text-muted-foreground"}
      />
    </Trigger>
  );
  const choices = options;
  if (options.length > 6) {
    const needle = query.trim().toLowerCase();
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matches found.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {choices.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ScopeOptionLabel option={option} />
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The machine a page's machine-local settings apply to. The scope sentence
 * uses it on machine pages; a machine-local row elsewhere names it `quiet`ly
 * after its title. It is a switcher only when there is another machine to pick.
 */
export function MachineScopeMenu({ quiet = false }: { quiet?: boolean }) {
  const { machine, search, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  return (
    <ScopeMenu
      quiet={quiet}
      ariaLabel="Machine"
      icon={
        machine ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(machine.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        machine
          ? settingsScopeEnvironmentLabel(machine, environments)
          : search.machine
            ? "Unavailable machine"
            : "No machines"
      }
      value={machine?.environmentId ?? ""}
      onChange={(next) => selectScope(selectMachineScope(search, next))}
      searchLabel="Search machines"
      options={environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return {
          value: environment.environmentId,
          label: primary,
          secondary:
            environments.length <= 1
              ? ""
              : secondary || settingsScopeEnvironmentAddress(environment),
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5 shrink-0"
            />
          ),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}
