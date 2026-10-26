import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsSearchTargetId } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

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
        <SettingsScopeNotice target="repository">
          Choose a repository to manage its name, icon, actions and checkouts.
        </SettingsScopeNotice>
      )}
    </div>
  );
}
