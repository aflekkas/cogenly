import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
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
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  ALL_PROJECTS_VALUE,
  selectMachineScope,
  selectProjectScope,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

/** Pages whose every row is saved on this client; they have no scope to pick. */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/connections",
  // Projects span every connected machine; the page names each project's own.
  "/settings/project-tags",
]);

/**
 * "Settings for <All projects>" at the top of a settings page, or "Settings
 * for <MacBook>" on a page about one machine's own state. Universal settings
 * have no machine to pick: they are written to every machine. The Repository
 * page manages one repository and has no scope.
 */
export function SettingsScopeSentence() {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  if (pathname === "/settings/projects") return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      <span className="shrink-0">Settings for</span>
      {scope.machinePage ? <MachineScopeMenu /> : <ProjectScopeMenu />}
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
  allOption,
  searchLabel,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<InlineButton tone="picker" />}
      className="min-w-0 max-w-72"
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
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
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The machine a page's machine-local settings apply to. The scope sentence
 * uses it on machine pages; a machine-local row elsewhere names it inline.
 */
export function MachineScopeMenu() {
  const { machine, search, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  return (
    <ScopeMenu
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
      allOption={null}
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

/** All projects, or one project folder: its overrides apply to every repository it holds. */
function ProjectScopeMenu() {
  const { folders, search, selectScope } = useSettingsScope();
  const selected = folders.find((folder) => folder.id === search.project);
  return (
    <ScopeMenu
      ariaLabel="Project"
      icon={
        selected ? (
          <ProjectFolderIcon color={selected.color} className="size-3.5" />
        ) : search.project || search.checkout ? null : (
          <LayersIcon aria-hidden className="size-3.5 shrink-0" />
        )
      }
      label={
        selected?.name ??
        (search.project || search.checkout ? "Unavailable project" : "All projects")
      }
      value={selected?.id ?? (search.project || search.checkout ? "" : ALL_PROJECTS_VALUE)}
      onChange={(next) => selectScope(selectProjectScope(search, next))}
      searchLabel="Search projects"
      allOption={{
        value: ALL_PROJECTS_VALUE,
        label: "All projects",
        icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
      }}
      options={folders.map((folder) => ({
        value: folder.id,
        label: folder.name,
        icon: <ProjectFolderIcon color={folder.color} className="size-3.5" />,
      }))}
    />
  );
}
