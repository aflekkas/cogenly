import { resolveEnvironmentMachineKind, type EnvironmentId } from "@cogenly/contracts";
import { ChevronRightIcon } from "lucide-react";

import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsList, SettingsListItem } from "./SettingsList";
import { SettingsPageMessage } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  selectMachineScope,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

/**
 * Offer an explicit machine when a page has nothing to show for the current
 * scope: the machines that support it, as rows that switch to that machine.
 * Settings rows never use this; they render at every scope.
 */
export function SettingsScopeNotice({
  children,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment";
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search } = useSettingsScope();
  const { environments } = useEnvironments();
  const choices = environments.filter(
    (entry) =>
      eligibleEnvironmentIds === undefined || eligibleEnvironmentIds.includes(entry.environmentId),
  );
  return (
    <div className="space-y-3">
      <SettingsPageMessage>{children}</SettingsPageMessage>
      <SettingsGroup>
        <SettingsList aria-label="Machines">
          {choices.map((entry) => {
            const { primary, secondary } = settingsScopeEnvironmentLabels(entry, environments);
            const address = secondary || settingsScopeEnvironmentAddress(entry);
            const open = () => selectScope(selectMachineScope(search, entry.environmentId));
            return (
              <SettingsListItem
                key={entry.environmentId}
                interactive
                role="button"
                tabIndex={0}
                aria-label={`Choose ${primary}`}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  open();
                }}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 truncate">{primary}</span>
                  </span>
                }
                description={
                  address ? (
                    <Tooltip>
                      <TooltipTrigger render={<span className="block truncate" />}>
                        {address}
                      </TooltipTrigger>
                      <TooltipPopup>{address}</TooltipPopup>
                    </Tooltip>
                  ) : undefined
                }
                control={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
              />
            );
          })}
        </SettingsList>
      </SettingsGroup>
    </div>
  );
}
