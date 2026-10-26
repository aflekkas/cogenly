import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectScopeMenu } from "./SettingsScopeSentence";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings → New threads: where new threads and worktrees start, and a
 * project's actions. Where added repositories go is on Settings → Projects.
 */
export function NewThreadsSettingsPanel() {
  const { scope } = useSettingsScope();
  return (
    <>
      <ProjectDefaultsSettings category="new-threads" />
      {scope.kind === "project" ? (
        <ProjectActionsSettings />
      ) : (
        // Actions belong to one project; outside one, the row stays reachable
        // from search and points at a project instead of disappearing.
        <SettingsSection id={searchableSetting("project-actions").id} title="Actions">
          <SettingsRow
            title="Project actions"
            description="Each project has its own actions. Choose a project to edit them."
            control={<ProjectScopeMenu />}
          />
        </SettingsSection>
      )}
    </>
  );
}
