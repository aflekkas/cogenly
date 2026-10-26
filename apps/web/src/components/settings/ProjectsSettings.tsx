import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

/** Repository identity and checkout management for the repository in `repository`. */
export function ProjectsSettings() {
  const { search } = useSettingsScope();
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
