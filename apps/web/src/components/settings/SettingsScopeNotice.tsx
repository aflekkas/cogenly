import { resolveEnvironmentMachineKind, type EnvironmentId } from "@cogenly/contracts";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageMessage } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  selectMachineScope,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

interface ScopeChoice {
  key: string;
  label: string;
  secondary?: string;
  icon: ReactNode;
  search: SettingsScopeSearch;
}

/**
 * Offer an explicit target change when a page has nothing to show for the
 * current one: a machine that supports it, or a repository for the Repository
 * page. Settings rows never use this; they render at every scope.
 */
export function SettingsScopeNotice({
  children,
  target,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "repository";
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search, groups } = useSettingsScope();
  const { environments } = useEnvironments();
  const choices: ScopeChoice[] =
    target === "repository"
      ? groups.map((group) => ({
          key: group.projectKey,
          label: group.displayName,
          secondary: group.workspaceRoot,
          icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
          search: { ...search, repository: group.projectKey },
        }))
      : environments
          .filter(
            (entry) =>
              eligibleEnvironmentIds === undefined ||
              eligibleEnvironmentIds.includes(entry.environmentId),
          )
          .map((entry) => {
            const { primary, secondary } = settingsScopeEnvironmentLabels(entry, environments);
            return {
              key: entry.environmentId,
              label: primary,
              secondary: secondary || settingsScopeEnvironmentAddress(entry),
              icon: (
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              ),
              search: selectMachineScope(search, entry.environmentId),
            };
          });
  return (
    <div className="space-y-3">
      <SettingsPageMessage>{children}</SettingsPageMessage>
      <SettingsGroup>
        {choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            className={cn(
              ITEM_ROW_CLASSNAME,
              "flex w-full min-w-0 cursor-pointer items-center gap-3 text-left outline-none state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
            onClick={() => selectScope(choice.search)}
          >
            {choice.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{choice.label}</span>
              {choice.secondary ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate text-xs text-muted-foreground" />}
                  >
                    {choice.secondary}
                  </TooltipTrigger>
                  <TooltipPopup>{choice.secondary}</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </SettingsGroup>
    </div>
  );
}
