import { DEFAULT_SERVER_SETTINGS } from "@cogenly/contracts";

import { Switch } from "../ui/switch";
import { ComputerUsePermissionsSetting } from "./ComputerUsePermissionsSetting";
import { UseOnlyCogenlyIntegrationsRow } from "./IntegrationServicesSettings";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Settings → Integrations → Agent access: what agents may reach beyond the
 * thread, the shared browser, this machine's apps, and the tools set up in
 * Claude or Codex. Each takes effect when an agent session next starts.
 */
export function AgentAccessSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection id="browser-access" title="Agent access">
      <SettingsRow
        serverScoped
        settingKeys={["enableAgentBrowserAccess"]}
        {...searchableSetting("agent-browser-access")}
        description="Let agents open and drive the shared browser. Applies to new agent sessions."
        resetAction={
          settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
            <SettingResetButton
              label="agent browser access"
              onClick={() =>
                updateSettings({
                  enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Agent browser access"
            checked={settings.enableAgentBrowserAccess}
            onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["enableAgentComputerUse"]}
        {...searchableSetting("agent-computer-use")}
        description="Let agents click, type and take screenshots in this machine's apps. Applies to new agent sessions."
        resetAction={
          settings.enableAgentComputerUse !== DEFAULT_SERVER_SETTINGS.enableAgentComputerUse ? (
            <SettingResetButton
              label="computer use"
              onClick={() =>
                updateSettings({
                  enableAgentComputerUse: DEFAULT_SERVER_SETTINGS.enableAgentComputerUse,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Computer use"
            checked={settings.enableAgentComputerUse}
            onCheckedChange={(enabled) => updateSettings({ enableAgentComputerUse: enabled })}
          />
        }
      />
      <ComputerUsePermissionsSetting enabled={settings.enableAgentComputerUse} />
      <UseOnlyCogenlyIntegrationsRow />
    </SettingsSection>
  );
}
