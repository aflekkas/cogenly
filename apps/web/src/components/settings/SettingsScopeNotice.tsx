import { resolveEnvironmentMachineKind, type EnvironmentId } from "@cogenly/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProjectFolderIcon } from "../../projectLabels/ProjectFolderMark";
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
  selectProjectScope,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabels,
  ALL_PROJECTS_VALUE,
} from "./settingsScopeAxis";

interface ScopeChoice {
  key: string;
  label: string;
  secondary?: string;
  icon: ReactNode;
  search: SettingsScopeSearch;
}

/**
 * Offer an explicit target change when a page has nothing at this scope:
 * a project, a machine, All projects, or a repository for the Repository page.
 */
export function SettingsScopeNotice({
  children,
  target,
  targetId,
  eligibleEnvironmentIds,
}: {
  children: string;
  target: "environment" | "all" | "project" | "repository";
  targetId?: string;
  eligibleEnvironmentIds?: readonly EnvironmentId[];
}) {
  const { selectScope, search, folders, groups } = useSettingsScope();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  const choices: ScopeChoice[] =
    target === "project"
      ? folders.map((folder) => ({
          key: folder.id,
          label: folder.name,
          icon: <ProjectFolderIcon project={folder.icon} className="size-4" />,
          search: selectProjectScope(search, folder.id),
        }))
      : target === "repository"
        ? groups.map((group) => ({
            key: group.projectKey,
            label: group.displayName,
            secondary: group.workspaceRoot,
            icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
            search: { ...search, repository: group.projectKey },
          }))
        : target === "environment"
          ? environments
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
              })
          : [
              {
                key: ALL_PROJECTS_VALUE,
                label: "Open All projects",
                icon: <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
                search: selectProjectScope(search, ALL_PROJECTS_VALUE),
              },
            ];
  return (
    <>
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
              onClick={() => {
                if (targetId)
                  void navigate({
                    to: pathname,
                    // Every key, so the retain middleware sees an explicit target.
                    search: () => ({
                      project: choice.search.project,
                      machine: choice.search.machine,
                      repository: choice.search.repository,
                      checkout: undefined,
                    }),
                    hash: targetId,
                    replace: true,
                  });
                else selectScope(choice.search);
              }}
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
    </>
  );
}
