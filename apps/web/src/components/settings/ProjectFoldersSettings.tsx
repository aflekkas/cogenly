import { DEFAULT_UNIFIED_SETTINGS } from "@cogenly/contracts/settings";

import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsField, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Settings → Projects: where Cogenly puts the folders it creates, and where
 * the folder browser opens to add a repository that already exists.
 */
export function ProjectFoldersSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  // Both folders are machine-local, so they edit the representative machine.
  const environmentId = environment?.environmentId ?? null;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The native folder picker browses this device, so it only offers a path
  // when the settings being edited are this device's server.
  const canPickProjectsRoot =
    environmentId !== null &&
    environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const pickProjectsRoot = async () => {
    const api = readLocalApi();
    if (!api) return;
    const current = settings.projectsRoot.trim();
    const picked = await api.dialogs
      .pickFolder(
        current.length > 0 && !current.startsWith("~") ? { initialPath: current } : undefined,
      )
      .catch(() => null);
    if (picked) updateSettings({ projectsRoot: picked });
  };

  return (
    <SettingsSection id="project-folder-locations" title="Locations">
      <SettingsRow
        serverScoped
        settingKeys={["projectsRoot"]}
        {...searchableSetting("projects-folder")}
        description="Where Cogenly creates projects and clones repositories. Existing folders don't move."
        resetAction={
          settings.projectsRoot !== DEFAULT_UNIFIED_SETTINGS.projectsRoot ? (
            <SettingResetButton
              label="projects folder"
              onClick={() =>
                updateSettings({ projectsRoot: DEFAULT_UNIFIED_SETTINGS.projectsRoot })
              }
            />
          ) : null
        }
        control={
          <SettingsField>
            <DraftInput
              size="sm"
              // A long path clips in the field; hovering shows all of it.
              title={settings.projectsRoot || undefined}
              value={settings.projectsRoot}
              onCommit={(next) => updateSettings({ projectsRoot: next })}
              placeholder={
                environment?.serverConfig?.defaultProjectsRoot ?? "<Cogenly home>/projects"
              }
              spellCheck={false}
              aria-label="Projects folder"
            />
            {canPickProjectsRoot ? (
              <Button size="sm" variant="outline" onClick={() => void pickProjectsRoot()}>
                Change…
              </Button>
            ) : null}
          </SettingsField>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["addProjectBaseDirectory"]}
        {...searchableSetting("add-project-starts-in")}
        description="Where the folder browser opens when you add an existing repository. Empty opens your home folder."
        resetAction={
          settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
            <SettingResetButton
              label="folder browser start"
              onClick={() =>
                updateSettings({
                  addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                })
              }
            />
          ) : null
        }
        control={
          <SettingsField>
            <DraftInput
              size="sm"
              title={settings.addProjectBaseDirectory || undefined}
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Folder browser starts in"
            />
          </SettingsField>
        }
      />
    </SettingsSection>
  );
}
