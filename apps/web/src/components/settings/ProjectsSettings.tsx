import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { useEffect } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { SettingsList, SettingsListItem } from "./SettingsList";
import {
  SettingsEmpty,
  SettingsPathText,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/** Search results that land inside one repository's settings. */
const REPOSITORY_SEARCH_TARGETS: ReadonlySet<string> = new Set([
  searchableSetting("project-overview").id,
  searchableSetting("project-actions").id,
]);

/** Repository identity and checkout management for the repository in `repository`. */
export function ProjectsSettings() {
  const { search, groups } = useSettingsScope();
  const navigate = useNavigate();
  const targetId = useSettingsSearchTargetId();
  // A search result for a repository's rows opens the most recently changed
  // repository instead of the picker, keeping the anchor so it lands on the row.
  const fallbackRepository =
    search.repository || targetId === null || !REPOSITORY_SEARCH_TARGETS.has(targetId)
      ? null
      : (groups.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
          ?.projectKey ?? null);
  useEffect(() => {
    if (fallbackRepository === null || targetId === null) return;
    void navigate({
      to: "/settings/projects",
      search: (previous) => ({ ...previous, repository: fallbackRepository }),
      hash: targetId,
      replace: true,
      resetScroll: false,
    });
  }, [fallbackRepository, navigate, targetId]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8">
      {search.repository ? (
        <ProjectSettingsPanel projectKey={search.repository} />
      ) : (
        <RepositoryList />
      )}
    </div>
  );
}

/** Every repository, as list rows that open its settings. */
function RepositoryList() {
  const { selectScope, search, groups } = useSettingsScope();
  return (
    <SettingsSection
      title="Repositories"
      footer="Choose a repository to manage its name, icon, actions and checkouts."
    >
      {groups.length === 0 ? (
        <SettingsEmpty
          icon={<FolderGit2Icon />}
          label="Repositories you add from the sidebar appear here."
        />
      ) : (
        <SettingsList aria-label="Repositories">
          {groups.map((group) => {
            const open = () => selectScope({ ...search, repository: group.projectKey });
            return (
              <SettingsListItem
                key={group.projectKey}
                interactive
                role="button"
                tabIndex={0}
                aria-label={`Open ${group.displayName}`}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  open();
                }}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectFavicon project={group} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">{group.displayName}</span>
                  </span>
                }
                description={
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0" />}>
                      <SettingsPathText path={group.workspaceRoot} />
                    </TooltipTrigger>
                    <TooltipPopup>{group.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                }
                control={<ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />}
              />
            );
          })}
        </SettingsList>
      )}
    </SettingsSection>
  );
}
