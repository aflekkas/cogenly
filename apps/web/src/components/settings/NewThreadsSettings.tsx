import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Settings → New threads: where new threads and worktrees start, where added
 * repositories go, and a project's actions.
 */
export function NewThreadsSettingsPanel() {
  const { scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="new-threads" />
      <AddingRepositoriesSettings />
      {scope.kind === "project" ? <ProjectActionsSettings /> : null}
    </SettingsPageContainer>
  );
}

function AddingRepositoriesSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  // The projects folder is machine-local, so it edits the representative machine.
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.kind !== "project" && environmentId !== null;
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  const mixedProjectsRoot = useScopedSettingsMixed(["projectsRoot"]);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The native folder picker browses this device, so it only offers a path
  // when the settings being edited are this device's server.
  const canPickProjectsRoot =
    isEnvironmentScope &&
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
    <SettingsSection id="projects-and-threads" title="Adding repositories">
      <SettingsRow
        serverScoped
        settingKeys={["addProjectBaseDirectory"]}
        {...searchableSetting("add-project-starts-in")}
        description='Leave empty to use "~/" when the Add Repository browser opens.'
        resetAction={
          settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
            <SettingResetButton
              label="add repository base directory"
              onClick={() =>
                updateSettings({
                  addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            className="w-full sm:w-72"
            value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
            onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
            placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
            spellCheck={false}
            aria-label="Add repository base directory"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["projectsRoot"]}
        {...searchableSetting("projects-folder")}
        description="Where new and cloned repositories go, in a folder per project. Existing repositories stay where they are."
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
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <DraftInput
              size="sm"
              className="w-full sm:w-56"
              value={mixedProjectsRoot ? "" : settings.projectsRoot}
              onCommit={(next) => updateSettings({ projectsRoot: next })}
              placeholder={
                mixedProjectsRoot
                  ? "Mixed"
                  : (environment?.serverConfig?.defaultProjectsRoot ?? "<Cogenly home>/projects")
              }
              spellCheck={false}
              aria-label="Projects folder"
            />
            {canPickProjectsRoot ? (
              <Button size="sm" variant="outline" onClick={() => void pickProjectsRoot()}>
                Change…
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
