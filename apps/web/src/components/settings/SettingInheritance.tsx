import {
  DEFAULT_SERVER_SETTINGS,
  isUniversalServerSettingKey,
  PROJECT_FILE_BACKED_SETTINGS,
  type ProjectFileBackedSettingKey,
  resolveEnvironmentMachineKind,
  type ServerSettings,
} from "@cogenly/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { formatSettingValue } from "./settingValueLabels";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ScopedSettingsTarget } from "./scopedSettings";

interface InheritanceLayer {
  readonly key: "environment" | "built-in";
  readonly label: string;
  readonly value: string;
  readonly effective: boolean;
  readonly set: boolean;
}

/**
 * The layers a setting resolves through, top-down: the value you set (a
 * machine-local key's is the machine's), then the built-in default. The first
 * layer that is set wins.
 */
export function settingInheritanceLayers(
  target: ScopedSettingsTarget,
  key: keyof ServerSettings,
): readonly InheritanceLayer[] {
  const value = target.settings[key];
  const set = !Equal.equals(value, DEFAULT_SERVER_SETTINGS[key]);
  // For a file-backed key the built-in is what applies with nothing set, not
  // the null the schema decodes to.
  const builtIn = Object.hasOwn(PROJECT_FILE_BACKED_SETTINGS, key)
    ? PROJECT_FILE_BACKED_SETTINGS[key as ProjectFileBackedSettingKey].builtIn
    : DEFAULT_SERVER_SETTINGS[key];
  return [
    {
      key: "environment",
      label: isUniversalServerSettingKey(key) ? "All machines" : target.label,
      value: set ? formatSettingValue(key, value) : "Inherits",
      effective: set,
      set,
    },
    {
      key: "built-in",
      label: "Default",
      value: formatSettingValue(key, builtIn),
      effective: !set,
      set: true,
    },
  ];
}

export type SettingInheritanceState = "default" | "environment";

/**
 * A small indicator beside a row's title that opens a top-down view of where
 * the setting's value comes from.
 */
export function SettingInheritance({
  state,
  summary,
  target,
  environment,
  settingKey,
}: {
  state: SettingInheritanceState;
  summary: string;
  target: ScopedSettingsTarget;
  environment: Pick<EnvironmentPresentation, "serverConfig"> | undefined;
  settingKey: keyof ServerSettings;
}) {
  const layers = settingInheritanceLayers(target, settingKey);
  // A universal value is the same on every machine, so its chain names no machine.
  const showsMachine = !isUniversalServerSettingKey(settingKey);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${summary}. Show where this value comes from`}
                />
              }
            />
          }
        >
          <LayersIcon className={cn("size-3", state === "environment" && "text-primary")} />
        </TooltipTrigger>
        <TooltipPopup side="top">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" width="md" padding="none">
        <section className="px-3 py-2.5">
          {showsMachine ? (
            <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 truncate">{target.label}</span>
            </h4>
          ) : null}
          <ol role="list" className="text-sm">
            {layers.map((layer) => (
              <li
                key={layer.key}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1",
                  layer.effective && "bg-foreground/[0.06]",
                )}
              >
                <span
                  className={cn(
                    "min-w-0 truncate",
                    layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {layer.label}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-1.5 tabular-nums",
                    layer.effective
                      ? "text-foreground"
                      : layer.set
                        ? "text-muted-foreground"
                        : "text-muted-foreground/60",
                  )}
                >
                  <span className="max-w-32 truncate">{layer.value}</span>
                  {layer.effective ? (
                    <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <span aria-hidden className="size-3.5 shrink-0" />
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </PopoverPopup>
    </Popover>
  );
}
